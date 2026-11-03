from __future__ import annotations

from dataclasses import dataclass

import pandas as pd

from .backtest import BacktestMetrics, run_signal_backtest
from .config import AppConfig
from .data import CoinGeckoClient, UniverseAsset, generate_demo_market
from .features import build_feature_panel, latest_feature_rows
from .model import ModelDiagnostics, ProbabilityModel
from .risk import TradePlan, build_trade_plans
from .strategies import add_strategy_statistics, annotate_chart_strategies


@dataclass(slots=True)
class AnalysisResult:
    assets: list[UniverseAsset]
    panel: pd.DataFrame
    scored: pd.DataFrame
    plans: list[TradePlan]
    diagnostics: ModelDiagnostics
    backtest: BacktestMetrics
    backtest_periods: pd.DataFrame
    source_label: str


def analyze_market(config: AppConfig, demo: bool = False, equity: float | None = None) -> AnalysisResult:
    if demo:
        assets, histories = generate_demo_market(max(config.market.lookback_days, 420))
        source_label = "SYNTHETIC DEMO DATA"
    else:
        client = CoinGeckoClient(config.market)
        assets = client.get_universe()
        histories = client.load_histories(assets)
        available = set(histories)
        assets = [asset for asset in assets if asset.coin_id in available]
        source_label = "CoinGecko read-only market data"

    panel = build_feature_panel(
        histories,
        horizon_days=config.market.horizon_days,
        round_trip_cost_fraction=config.risk.round_trip_cost_fraction,
    )
    panel = annotate_chart_strategies(panel, config.strategy)
    model = ProbabilityModel(config.model, config.market.horizon_days)
    predictions = model.walk_forward_validate(panel)
    if model.diagnostics is None:
        raise RuntimeError("Model diagnostics were not produced")
    metrics, periods = run_signal_backtest(
        predictions,
        config.risk,
        config.model.probability_threshold,
        config.market.horizon_days,
        minimum_trades=config.strategy.minimum_backtest_trades,
    )
    model.fit(panel)
    scored = latest_feature_rows(panel)
    scored["probability_up"] = model.predict(scored)
    scored = scored.sort_values("probability_up", ascending=False).reset_index(drop=True)
    scored = add_strategy_statistics(
        panel,
        scored,
        config.strategy,
        config.risk.round_trip_cost_fraction,
    ).sort_values("probability_up", ascending=False).reset_index(drop=True)
    plans = build_trade_plans(
        scored,
        config.risk,
        config.model.probability_threshold,
        model.diagnostics.quality_pass,
        equity if equity is not None else config.risk.starting_cash,
        config.strategy,
        config.market.horizon_days,
        metrics.quality_pass,
    )
    return AnalysisResult(assets, panel, scored, plans, model.diagnostics, metrics, periods, source_label)
