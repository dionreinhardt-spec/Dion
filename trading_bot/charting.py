from __future__ import annotations

import re
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd

from .risk import TradePlan


def _safe_name(value: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9_-]+", "_", value).strip("_")
    return cleaned or "asset"


def render_strategy_charts(
    panel: pd.DataFrame,
    plans: list[TradePlan],
    backtest_periods: pd.DataFrame,
    output_dir: str | Path,
    lookback_days: int = 120,
) -> list[Path]:
    """Render auditable strategy charts from the same rows used by the bot."""

    directory = Path(output_dir)
    directory.mkdir(parents=True, exist_ok=True)
    created: list[Path] = []

    for plan in plans:
        history = panel[panel["asset_id"] == plan.asset_id].sort_values("date").tail(lookback_days).copy()
        if history.empty:
            continue
        dates = pd.DatetimeIndex(pd.to_datetime(history["date"])).to_pydatetime()
        close = history["close"].astype(float).to_numpy()
        sma_20 = history["sma_20"].astype(float).to_numpy()
        sma_50 = history["sma_50"].astype(float).to_numpy()
        upper = history["bollinger_upper"].astype(float).to_numpy()
        lower = history["bollinger_lower"].astype(float).to_numpy()
        volume = history["volume"].astype(float).to_numpy()

        fig, (price_ax, volume_ax) = plt.subplots(
            2,
            1,
            figsize=(12, 7),
            sharex=True,
            gridspec_kw={"height_ratios": [3.2, 1]},
        )
        price_ax.plot(dates, close, label="Close", linewidth=1.8, color="#1f77b4")
        price_ax.plot(dates, sma_20, label="SMA 20", linewidth=1.1, color="#ff7f0e")
        price_ax.plot(dates, sma_50, label="SMA 50", linewidth=1.1, color="#9467bd")
        price_ax.fill_between(dates, lower, upper, color="#9ecae1", alpha=0.18, label="Bollinger band")
        price_ax.scatter(dates[-1], close[-1], color="#111827", zorder=5, label="Analysis point")
        price_ax.axhline(plan.price, color="#374151", linestyle=":", linewidth=1.0, label="Entry reference")
        price_ax.axhline(plan.stop_price, color="#dc2626", linestyle="--", linewidth=1.0, label="Paper stop")
        price_ax.axhline(plan.target_price, color="#16a34a", linestyle="--", linewidth=1.0, label="Paper target")
        price_ax.set_title(
            f"{plan.symbol} | {plan.strategy} | {plan.market_regime} | p(up) {plan.probability_up:.1%}"
        )
        price_ax.set_ylabel("Price")
        price_ax.grid(alpha=0.2)
        price_ax.legend(loc="best", ncols=2, fontsize=8)

        changes = np.diff(close, prepend=close[0])
        colors = np.where(changes >= 0, "#16a34a", "#dc2626")
        volume_ax.bar(dates, volume, color=colors, alpha=0.55, width=0.8)
        volume_ax.set_ylabel("Volume")
        volume_ax.set_xlabel("Date")
        volume_ax.grid(axis="y", alpha=0.2)
        fig.text(
            0.01,
            0.01,
            (
                f"Action: {plan.action} | strategy history: {plan.strategy_samples} asset observations, "
                f"smoothed win {plan.strategy_win_rate:.1%}, net expectancy {plan.strategy_expected_net_return:+.2%}. "
                "Research/paper trading only."
            ),
            fontsize=8,
            color="#374151",
        )
        fig.tight_layout(rect=(0, 0.04, 1, 1))
        path = directory / f"{_safe_name(plan.symbol)}_strategy.png"
        fig.savefig(path, dpi=150, bbox_inches="tight")
        plt.close(fig)
        created.append(path)

    if not backtest_periods.empty:
        periods = backtest_periods.sort_values("date")
        fig, ax = plt.subplots(figsize=(12, 5.5))
        period_dates = pd.DatetimeIndex(pd.to_datetime(periods["date"]))
        initial_date = period_dates.min() - pd.Timedelta(days=1)
        dates = pd.DatetimeIndex([initial_date, *period_dates]).to_pydatetime()
        strategy_equity = np.r_[1.0, periods["equity"].astype(float).to_numpy()]
        benchmark_equity = np.r_[1.0, periods["benchmark_equity"].astype(float).to_numpy()]
        ax.plot(dates, strategy_equity, label="Model + chart strategy", linewidth=2.0)
        ax.plot(dates, benchmark_equity, label="Bitcoin benchmark", linewidth=1.4)
        ax.axhline(1.0, color="#6b7280", linewidth=0.8, linestyle=":")
        ax.set_title("Purged walk-forward backtest after assumed costs")
        ax.set_ylabel("Growth of 1.00 before first test period")
        ax.set_xlabel("Date")
        ax.grid(alpha=0.2)
        ax.legend()
        fig.tight_layout()
        path = directory / "walk_forward_equity.png"
        fig.savefig(path, dpi=150, bbox_inches="tight")
        plt.close(fig)
        created.append(path)

    return created
