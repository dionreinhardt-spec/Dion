from __future__ import annotations

from dataclasses import asdict, dataclass

import numpy as np
import pandas as pd

from .config import RiskConfig


@dataclass(slots=True)
class BacktestMetrics:
    periods: int
    trades: int
    win_rate: float
    average_net_trade_return: float
    compounded_return: float
    annualized_return: float
    annualized_volatility: float
    sharpe: float | None
    max_drawdown: float
    benchmark_compounded_return: float
    strategy_trade_counts: dict[str, int]
    quality_pass: bool
    reason: str

    def to_dict(self) -> dict[str, object]:
        return asdict(self)


def _max_drawdown(equity: pd.Series) -> float:
    if equity.empty:
        return 0.0
    peak = equity.cummax()
    return float((equity / peak - 1).min())


def run_signal_backtest(
    predictions: pd.DataFrame,
    risk: RiskConfig,
    probability_threshold: float,
    horizon_days: int,
    benchmark_id: str = "bitcoin",
    minimum_trades: int = 20,
) -> tuple[BacktestMetrics, pd.DataFrame]:
    data = predictions.copy().sort_values(["date", "probability_up"], ascending=[True, False])
    unique_dates = np.array(sorted(data["date"].unique()))
    rebalance_dates = unique_dates[::horizon_days]
    period_rows = []
    trade_returns: list[float] = []
    strategy_trade_counts: dict[str, int] = {}
    for date in rebalance_dates:
        day = data[data["date"] == date]
        eligible = day["probability_up"] >= probability_threshold
        if "chart_strategy" in day:
            eligible &= day["chart_strategy"] != "CASH_DEFENSIVE"
        selected = day[eligible].head(risk.max_positions)
        if selected.empty:
            portfolio_return = 0.0
        else:
            gross = selected["forward_return"].clip(lower=-0.99)
            net = gross - risk.round_trip_cost_fraction
            trade_returns.extend(net.tolist())
            if "chart_strategy" in selected:
                for strategy, count in selected["chart_strategy"].value_counts().items():
                    strategy_trade_counts[str(strategy)] = strategy_trade_counts.get(str(strategy), 0) + int(count)
            exposure = min(risk.max_portfolio_exposure, risk.max_position_fraction * len(selected))
            portfolio_return = float(net.mean() * exposure)
        benchmark = day[day["asset_id"] == benchmark_id]
        benchmark_return = float(benchmark["forward_return"].iloc[0]) if not benchmark.empty else 0.0
        period_rows.append(
            {
                "date": pd.Timestamp(date),
                "portfolio_return": portfolio_return,
                "benchmark_return": benchmark_return,
                "positions": int(len(selected)),
            }
        )
    periods = pd.DataFrame(period_rows)
    if periods.empty:
        raise ValueError("No backtest periods were produced")
    periods["equity"] = (1 + periods["portfolio_return"]).cumprod()
    periods["benchmark_equity"] = (1 + periods["benchmark_return"]).cumprod()
    periods_per_year = 365 / horizon_days
    mean = float(periods["portfolio_return"].mean())
    std = float(periods["portfolio_return"].std(ddof=0))
    annualized_return = float(periods["equity"].iloc[-1] ** (periods_per_year / len(periods)) - 1)
    annualized_volatility = std * np.sqrt(periods_per_year)
    sharpe = (mean / std) * np.sqrt(periods_per_year) if std > 0 else None
    trades = len(trade_returns)
    compounded_return = float(periods["equity"].iloc[-1] - 1)
    max_drawdown = _max_drawdown(periods["equity"])
    average_net_trade_return = float(np.mean(trade_returns)) if trades else 0.0
    gate_reasons = []
    if trades < minimum_trades:
        gate_reasons.append(f"fewer than {minimum_trades} strategy trades")
    if compounded_return <= 0:
        gate_reasons.append("non-positive compounded return after costs")
    if average_net_trade_return <= 0:
        gate_reasons.append("non-positive average trade return after costs")
    if max_drawdown < -0.25:
        gate_reasons.append("maximum drawdown exceeds 25%")
    quality_pass = not gate_reasons
    metrics = BacktestMetrics(
        periods=len(periods),
        trades=trades,
        win_rate=float(np.mean(np.array(trade_returns) > 0)) if trades else 0.0,
        average_net_trade_return=average_net_trade_return,
        compounded_return=compounded_return,
        annualized_return=annualized_return,
        annualized_volatility=annualized_volatility,
        sharpe=sharpe,
        max_drawdown=max_drawdown,
        benchmark_compounded_return=float(periods["benchmark_equity"].iloc[-1] - 1),
        strategy_trade_counts=strategy_trade_counts,
        quality_pass=quality_pass,
        reason="economic backtest gate passed" if quality_pass else "; ".join(gate_reasons),
    )
    return metrics, periods
