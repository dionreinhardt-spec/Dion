from __future__ import annotations

import json
import tempfile
import threading
import unittest
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

import numpy as np
import pandas as pd

from trading_bot.charting import render_strategy_charts
from trading_bot.cli import build_parser
from trading_bot.config import AppConfig, RiskConfig, StrategyConfig
from trading_bot.data import CoinGeckoClient, MarketDataError, generate_demo_market
from trading_bot.features import FEATURE_COLUMNS, build_feature_panel
from trading_bot.model import ProbabilityModel
from trading_bot.paper import PaperPortfolio
from trading_bot.risk import TradePlan, build_trade_plans
from trading_bot.strategies import annotate_chart_strategies
from trading_bot.webapp import DashboardState, STATIC_DIR, _handler_for


class FeatureTests(unittest.TestCase):
    def test_features_do_not_look_into_future(self) -> None:
        _, histories = generate_demo_market(days=240, seed=3)
        original = build_feature_panel(histories, 7, 0.005)
        modified_histories = {key: value.copy() for key, value in histories.items()}
        modified_histories["bitcoin"].loc[modified_histories["bitcoin"].index[-1], "close"] *= 10
        changed = build_feature_panel(modified_histories, 7, 0.005)
        cutoff = original["date"].max() - pd.Timedelta(days=2)
        left = original[(original.asset_id == "bitcoin") & (original.date <= cutoff)][FEATURE_COLUMNS]
        right = changed[(changed.asset_id == "bitcoin") & (changed.date <= cutoff)][FEATURE_COLUMNS]
        pd.testing.assert_frame_equal(left.reset_index(drop=True), right.reset_index(drop=True))


class DataClientTests(unittest.TestCase):
    def test_real_scan_requires_api_key_before_network_call(self) -> None:
        with tempfile.TemporaryDirectory() as directory, patch.dict("os.environ", {"COINGECKO_API_KEY": ""}):
            client = CoinGeckoClient(AppConfig().market, cache_dir=directory)
            with self.assertRaises(MarketDataError):
                client.get_universe()


class ModelTests(unittest.TestCase):
    def test_walk_forward_is_purged(self) -> None:
        config = AppConfig()
        _, histories = generate_demo_market(days=420, seed=5)
        panel = build_feature_panel(histories, config.market.horizon_days, config.risk.round_trip_cost_fraction)
        model = ProbabilityModel(config.model, config.market.horizon_days)
        predictions = model.walk_forward_validate(panel)
        gap = predictions["date"] - predictions["train_max_date"]
        self.assertTrue((gap >= pd.Timedelta(days=config.market.horizon_days)).all())
        self.assertTrue(((predictions.probability_up >= 0) & (predictions.probability_up <= 1)).all())


class RiskTests(unittest.TestCase):
    def test_model_gate_prevents_trade(self) -> None:
        row = {
            "asset_id": "x",
            "symbol": "X",
            "close": 10.0,
            "probability_up": 0.9,
            "volatility_20": 0.8,
            "market_cap": 1_000_000_000,
            "turnover": 0.1,
            "ret_7d": 0.1,
            "relative_strength_7d": 0.05,
            "rsi_14": 0.6,
        }
        plans = build_trade_plans(pd.DataFrame([row]), RiskConfig(), 0.6, False, 100_000)
        self.assertEqual(plans[0].action, "NO_TRADE_MODEL_GATE")
        self.assertEqual(plans[0].position_fraction, 0)

    def test_position_size_respects_caps(self) -> None:
        row = {
            "asset_id": "x",
            "symbol": "X",
            "close": 10.0,
            "probability_up": 0.9,
            "volatility_20": 0.2,
            "market_cap": 10_000_000_000,
            "turnover": 0.05,
            "ret_7d": 0.1,
            "relative_strength_7d": 0.05,
            "rsi_14": 0.6,
        }
        risk = RiskConfig(max_position_fraction=0.08)
        plan = build_trade_plans(pd.DataFrame([row]), risk, 0.6, True, 100_000)[0]
        self.assertLessEqual(plan.position_fraction, 0.08)
        self.assertLess(plan.stop_price, plan.price)
        self.assertGreater(plan.target_price, plan.price)

    def test_strategy_gate_prevents_unconfirmed_setup(self) -> None:
        row = {
            "asset_id": "x",
            "symbol": "X",
            "close": 10.0,
            "probability_up": 0.9,
            "volatility_20": 0.5,
            "market_cap": 10_000_000_000,
            "turnover": 0.05,
            "ret_7d": 0.1,
            "relative_strength_7d": 0.05,
            "rsi_14": 0.6,
            "chart_strategy": "MOMENTUM_BREAKOUT",
            "market_regime": "BULL_TREND",
            "strategy_confirmed": False,
            "strategy_gate_reason": "too few observations",
        }
        plan = build_trade_plans(
            pd.DataFrame([row]),
            RiskConfig(),
            0.6,
            True,
            100_000,
            StrategyConfig(require_confirmation=True),
        )[0]
        self.assertEqual(plan.action, "WATCH_STRATEGY_GATE")
        self.assertEqual(plan.position_fraction, 0)

    def test_backtest_gate_prevents_trade(self) -> None:
        row = {
            "asset_id": "x",
            "symbol": "X",
            "close": 10.0,
            "probability_up": 0.9,
            "volatility_20": 0.5,
            "market_cap": 10_000_000_000,
            "turnover": 0.05,
            "ret_7d": 0.1,
            "relative_strength_7d": 0.05,
            "rsi_14": 0.6,
            "chart_strategy": "TREND_PULLBACK",
        }
        plan = build_trade_plans(
            pd.DataFrame([row]),
            RiskConfig(),
            0.6,
            True,
            100_000,
            StrategyConfig(require_confirmation=False),
            backtest_quality_pass=False,
        )[0]
        self.assertEqual(plan.action, "NO_TRADE_BACKTEST_GATE")
        self.assertEqual(plan.position_fraction, 0)


class StrategyTests(unittest.TestCase):
    def test_breakout_rule_and_high_volatility_abstention(self) -> None:
        base = {
            "trend_20": 0.08,
            "trend_50": 0.12,
            "volatility_20": 0.70,
            "bollinger_z": 1.2,
            "volume_z_20": 1.0,
            "relative_strength_7d": 0.08,
            "relative_strength_30d": 0.10,
            "rsi_14": 0.65,
            "macd_norm": 0.03,
        }
        frame = pd.DataFrame([base, {**base, "volatility_20": 1.8}])
        annotated = annotate_chart_strategies(frame, StrategyConfig())
        self.assertEqual(annotated.iloc[0]["chart_strategy"], "MOMENTUM_BREAKOUT")
        self.assertEqual(annotated.iloc[1]["chart_strategy"], "CASH_DEFENSIVE")
        self.assertEqual(annotated.iloc[1]["market_regime"], "HIGH_VOLATILITY")


class ChartAndCliTests(unittest.TestCase):
    def test_cli_accepts_config_after_command(self) -> None:
        args = build_parser().parse_args(["scan", "--config", "x.yaml", "--no-charts"])
        self.assertEqual(args.config, "x.yaml")
        self.assertTrue(args.no_charts)

    def test_app_command_parses(self) -> None:
        args = build_parser().parse_args(["app", "--demo", "--port", "9000", "--no-browser"])
        self.assertTrue(args.demo)
        self.assertEqual(args.port, 9000)
        self.assertTrue(args.no_browser)

    def test_strategy_chart_is_created(self) -> None:
        config = AppConfig()
        _, histories = generate_demo_market(days=240, seed=11)
        panel = annotate_chart_strategies(
            build_feature_panel(histories, config.market.horizon_days, config.risk.round_trip_cost_fraction),
            config.strategy,
        )
        plan = TradePlan(
            "bitcoin",
            "BTC",
            float(histories["bitcoin"].close.iloc[-1]),
            0.65,
            "WATCH_STRATEGY_GATE",
            "core",
            0.0,
            0.0,
            float(histories["bitcoin"].close.iloc[-1]) * 0.94,
            float(histories["bitcoin"].close.iloc[-1]) * 1.12,
            "test",
            strategy="TREND_PULLBACK",
            market_regime="BULL_TREND",
        )
        periods = pd.DataFrame(
            {
                "date": pd.date_range("2025-01-01", periods=3, tz="UTC"),
                "equity": [1.0, 1.02, 1.01],
                "benchmark_equity": [1.0, 0.99, 1.03],
            }
        )
        with tempfile.TemporaryDirectory() as directory:
            paths = render_strategy_charts(panel, [plan], periods, directory, 90)
            self.assertEqual(len(paths), 2)
            self.assertTrue(all(path.exists() and path.stat().st_size > 1_000 for path in paths))


class WebAppTests(unittest.TestCase):
    def test_static_assets_are_complete(self) -> None:
        for name in ["index.html", "styles.css", "app.js"]:
            path = STATIC_DIR / name
            self.assertTrue(path.is_file())
            self.assertGreater(path.stat().st_size, 1_000)

    def test_health_endpoint_and_security_headers(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            state = DashboardState(AppConfig(), demo=True, data_dir=directory)
            server = ThreadingHTTPServer(("127.0.0.1", 0), _handler_for(state))
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                with urllib.request.urlopen(
                    f"http://127.0.0.1:{server.server_address[1]}/api/health", timeout=5
                ) as response:
                    payload = json.loads(response.read())
                    self.assertEqual(payload["status"], "ok")
                    self.assertTrue(payload["paper_only"])
                    self.assertEqual(response.headers["X-Frame-Options"], "DENY")
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=5)


class PaperBrokerTests(unittest.TestCase):
    def test_round_trip_changes_only_paper_ledger(self) -> None:
        risk = RiskConfig(starting_cash=10_000)
        portfolio = PaperPortfolio(cash=10_000)
        plan = TradePlan("x", "X", 10.0, 0.7, "PAPER_BUY", "core", 0.1, 1_000, 9.0, 12.0, "test")
        portfolio.execute_plans([plan], risk, {"x": 10.0})
        self.assertIn("x", portfolio.positions)
        portfolio.mark_and_exit({"x": 12.5}, risk)
        self.assertNotIn("x", portfolio.positions)
        self.assertGreater(portfolio.cash, 10_000)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "ledger.json"
            portfolio.save(path)
            loaded = PaperPortfolio.load(path, 1)
            self.assertAlmostEqual(loaded.cash, portfolio.cash)
            self.assertEqual(len(loaded.transactions), 2)

    def test_paper_broker_enforces_position_count(self) -> None:
        risk = RiskConfig(starting_cash=10_000, max_positions=1, max_portfolio_exposure=0.5)
        portfolio = PaperPortfolio(cash=10_000)
        plans = [
            TradePlan("x", "X", 10.0, 0.7, "PAPER_BUY", "core", 0.1, 1_000, 9.0, 12.0, "test"),
            TradePlan("y", "Y", 20.0, 0.7, "PAPER_BUY", "core", 0.1, 1_000, 18.0, 24.0, "test"),
        ]
        portfolio.execute_plans(plans, risk, {"x": 10.0, "y": 20.0})
        self.assertEqual(len(portfolio.positions), 1)


if __name__ == "__main__":
    unittest.main()
