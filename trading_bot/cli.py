from __future__ import annotations

import argparse
import json
import sys
import time
from datetime import UTC, datetime
from pathlib import Path

import pandas as pd

from .charting import render_strategy_charts
from .config import AppConfig, load_config
from .data import MarketDataError
from .engine import AnalysisResult, analyze_market
from .paper import PaperPortfolio
from .webapp import serve_app


DISCLAIMER = (
    "Research/paper-trading software only. It cannot predict markets with certainty and does not place real orders. "
    "Crypto can lose all value."
)


def _format_pct(value: float | None) -> str:
    return "n/a" if value is None else f"{value:.2%}"


def _print_result(result: AnalysisResult) -> None:
    diagnostics = result.diagnostics
    backtest = result.backtest
    print(f"\nDATA: {result.source_label}")
    print(f"MODEL GATE: {'PASS' if diagnostics.quality_pass else 'BLOCK'} — {diagnostics.reason}")
    auc = "n/a" if diagnostics.roc_auc is None else f"{diagnostics.roc_auc:.3f}"
    print(
        "VALIDATION: "
        f"rows={diagnostics.validation_rows}, Brier={diagnostics.brier_score:.4f} "
        f"(baseline={diagnostics.baseline_brier:.4f}), AUC={auc}, "
        f"calibration error={diagnostics.calibration_error:.3f}"
    )
    print(
        "BACKTEST AFTER COSTS: "
        f"return={_format_pct(backtest.compounded_return)}, max drawdown={_format_pct(backtest.max_drawdown)}, "
        f"win rate={_format_pct(backtest.win_rate)}, trades={backtest.trades}, "
        f"benchmark={_format_pct(backtest.benchmark_compounded_return)}"
    )
    print(f"BACKTEST GATE: {'PASS' if backtest.quality_pass else 'BLOCK'} — {backtest.reason}")
    rows = pd.DataFrame([plan.to_dict() for plan in result.plans])
    display = rows.head(10)[[
        "symbol",
        "action",
        "strategy",
        "market_regime",
        "probability_up",
        "strategy_win_rate",
        "strategy_expected_net_return",
        "price",
        "position_fraction",
        "stop_price",
        "target_price",
    ]].copy()
    display["probability_up"] = display["probability_up"].map(lambda x: f"{x:.1%}")
    display["strategy_win_rate"] = display["strategy_win_rate"].map(lambda x: f"{x:.1%}")
    display["strategy_expected_net_return"] = display["strategy_expected_net_return"].map(lambda x: f"{x:+.2%}")
    display["position_fraction"] = display["position_fraction"].map(lambda x: f"{x:.1%}")
    print("\nCURRENT PAPER PLAN")
    print(display.to_string(index=False))
    if len(rows) > len(display):
        print(f"... {len(rows) - len(display)} additional assets are included in the JSON result")
    print(f"\n{DISCLAIMER}")


def _render_result_charts(result: AnalysisResult, config: AppConfig, charts_dir: str, no_charts: bool) -> list[str]:
    if no_charts:
        return []
    ordered_plans = sorted(
        result.plans,
        key=lambda plan: (plan.action == "PAPER_BUY", plan.probability_up),
        reverse=True,
    )[: config.risk.max_positions]
    paths = render_strategy_charts(
        result.panel,
        ordered_plans,
        result.backtest_periods,
        charts_dir,
        config.strategy.chart_lookback_days,
    )
    print(f"CHARTS: {', '.join(str(path) for path in paths)}")
    return [str(path) for path in paths]


def _write_json(result: AnalysisResult, path: str | Path, chart_files: list[str] | None = None) -> None:
    payload = {
        "generated_at": datetime.now(UTC).isoformat(),
        "data_as_of": pd.Timestamp(result.scored["date"].max()).isoformat(),
        "source": result.source_label,
        "diagnostics": result.diagnostics.to_dict(),
        "backtest": result.backtest.to_dict(),
        "plans": [plan.to_dict() for plan in result.plans],
        "chart_files": chart_files or [],
    }
    output = Path(path)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(payload, indent=2), encoding="utf-8")


def _analyze(
    config: AppConfig,
    demo: bool,
    output_json: str | None = None,
    equity: float | None = None,
    charts_dir: str = "charts",
    no_charts: bool = False,
) -> AnalysisResult:
    result = analyze_market(config, demo=demo, equity=equity)
    _print_result(result)
    chart_files = _render_result_charts(result, config, charts_dir, no_charts)
    if output_json:
        _write_json(result, output_json, chart_files)
        print(f"Saved machine-readable result to {output_json}")
    return result


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="ai-paper-trader", description=DISCLAIMER)
    parser.add_argument("--config", dest="global_config", help="YAML config path (also accepted after the command)")
    sub = parser.add_subparsers(dest="command", required=True)
    for name in ["scan", "backtest", "paper"]:
        cmd = sub.add_parser(name)
        cmd.add_argument("--config", help="YAML config path")
        cmd.add_argument("--demo", action="store_true", help="Use deterministic synthetic data, not real markets")
        cmd.add_argument("--json", dest="output_json", help="Write compact results to JSON")
        cmd.add_argument("--charts-dir", default="charts", help="Directory for strategy and backtest charts")
        cmd.add_argument("--no-charts", action="store_true", help="Skip PNG chart generation")
    paper = sub.choices["paper"]
    paper.add_argument("--ledger", default="paper_portfolio.json", help="Paper portfolio JSON path")
    run = sub.add_parser("run", help="Repeated scans; still paper-only")
    run.add_argument("--config", help="YAML config path")
    run.add_argument("--demo", action="store_true")
    run.add_argument("--interval", type=int, default=900, help="Seconds between scans (minimum 60)")
    run.add_argument("--iterations", type=int, default=1, help="0 means until interrupted")
    run.add_argument("--ledger", default="paper_portfolio.json")
    run.add_argument("--json", dest="output_json", help="Overwrite a machine-readable snapshot each iteration")
    run.add_argument("--charts-dir", default="charts", help="Directory for strategy and backtest charts")
    run.add_argument("--no-charts", action="store_true", help="Skip PNG chart generation")
    app = sub.add_parser("app", help="Launch the local browser dashboard")
    app.add_argument("--config", help="YAML config path")
    app.add_argument("--demo", action="store_true", help="Use deterministic synthetic data")
    app.add_argument("--host", default="127.0.0.1", help="Bind address; keep loopback unless the network is secured")
    app.add_argument("--port", type=int, default=8765)
    app.add_argument("--data-dir", default=".paper_trader_app", help="Local dashboard state directory")
    app.add_argument("--no-browser", action="store_true", help="Do not open the default browser")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        config = load_config(args.config or args.global_config)
        if args.command == "app":
            return serve_app(
                config,
                demo=args.demo,
                host=args.host,
                port=args.port,
                data_dir=args.data_dir,
                open_browser=not args.no_browser,
            )
        if args.command in {"scan", "backtest"}:
            _analyze(config, args.demo, args.output_json, charts_dir=args.charts_dir, no_charts=args.no_charts)
            return 0
        if args.command == "paper":
            portfolio = PaperPortfolio.load(args.ledger, config.risk.starting_cash)
            result = analyze_market(config, demo=args.demo, equity=portfolio.equity({}))
            prices = {str(row.asset_id): float(row.close) for row in result.scored.itertuples(index=False)}
            for message in portfolio.mark_and_exit(prices, config.risk):
                print(message)
            if result.diagnostics.quality_pass:
                for message in portfolio.execute_plans(result.plans, config.risk, prices):
                    print(message)
            else:
                print(f"No entries: model gate blocked ({result.diagnostics.reason})")
            portfolio.save(args.ledger)
            _print_result(result)
            chart_files = _render_result_charts(result, config, args.charts_dir, args.no_charts)
            print(f"PAPER EQUITY: {portfolio.equity(prices):,.2f} {config.market.vs_currency.upper()}")
            if args.output_json:
                _write_json(result, args.output_json, chart_files)
            return 0
        if args.command == "run":
            if args.interval < 60:
                raise ValueError("run interval must be at least 60 seconds")
            iteration = 0
            while args.iterations == 0 or iteration < args.iterations:
                portfolio = PaperPortfolio.load(args.ledger, config.risk.starting_cash)
                result = analyze_market(config, demo=args.demo, equity=portfolio.equity({}))
                prices = {str(row.asset_id): float(row.close) for row in result.scored.itertuples(index=False)}
                messages = portfolio.mark_and_exit(prices, config.risk)
                if result.diagnostics.quality_pass:
                    messages.extend(portfolio.execute_plans(result.plans, config.risk, prices))
                portfolio.save(args.ledger)
                _print_result(result)
                chart_files = _render_result_charts(result, config, args.charts_dir, args.no_charts)
                if args.output_json:
                    _write_json(result, args.output_json, chart_files)
                for message in messages:
                    print(message)
                iteration += 1
                if args.iterations == 0 or iteration < args.iterations:
                    time.sleep(args.interval)
            return 0
    except (ValueError, RuntimeError, MarketDataError, OSError, json.JSONDecodeError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
