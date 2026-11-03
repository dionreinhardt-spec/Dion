from __future__ import annotations

import numpy as np
import pandas as pd

from .config import StrategyConfig


CASH_STRATEGY = "CASH_DEFENSIVE"
TRADE_STRATEGIES = ("MOMENTUM_BREAKOUT", "TREND_PULLBACK", "RANGE_MEAN_REVERSION")


def annotate_chart_strategies(frame: pd.DataFrame, config: StrategyConfig) -> pd.DataFrame:
    """Classify the observable chart state without using future prices.

    The rules deliberately abstain often. They are confirmations for a calibrated
    probability model, not standalone claims that a pattern must repeat.
    """

    result = frame.copy()
    high_volatility = result["volatility_20"] > config.high_volatility_cutoff
    bull = (result["trend_20"] > 0) & (result["trend_50"] > 0)
    bear = (result["trend_20"] < 0) & (result["trend_50"] < 0)
    result["market_regime"] = np.select(
        [high_volatility, bull, bear],
        ["HIGH_VOLATILITY", "BULL_TREND", "BEAR_TREND"],
        default="RANGE_MIXED",
    )

    rsi = result["rsi_14"]
    breakout = (
        bull
        & ~high_volatility
        & (result["bollinger_z"] >= 0.70)
        & (result["volume_z_20"] >= 0.25)
        & (result["relative_strength_7d"] > 0)
        & rsi.between(0.52, 0.82)
    )
    trend_pullback = (
        bull
        & ~high_volatility
        & (result["macd_norm"] > 0)
        & result["bollinger_z"].between(-1.10, 0.70, inclusive="left")
        & rsi.between(0.40, 0.68)
        & (result["relative_strength_30d"] > -0.03)
    )
    mean_reversion = (
        ~high_volatility
        & ~bear
        & (result["trend_50"].abs() < 0.10)
        & (result["bollinger_z"] <= -1.00)
        & (rsi <= 0.43)
    )

    result["chart_strategy"] = np.select(
        [breakout, trend_pullback, mean_reversion],
        ["MOMENTUM_BREAKOUT", "TREND_PULLBACK", "RANGE_MEAN_REVERSION"],
        default=CASH_STRATEGY,
    )

    breakout_strength = (
        0.30 * np.clip((result["bollinger_z"] - 0.70) / 1.30, 0, 1)
        + 0.25 * np.clip((result["volume_z_20"] - 0.25) / 1.75, 0, 1)
        + 0.25 * np.clip(result["relative_strength_7d"] / 0.15, 0, 1)
        + 0.20 * np.clip((rsi - 0.52) / 0.20, 0, 1)
    )
    pullback_strength = (
        0.35 * np.clip(result["trend_50"] / 0.20, 0, 1)
        + 0.25 * np.clip(result["macd_norm"] / 0.05, 0, 1)
        + 0.20 * np.clip((0.70 - result["bollinger_z"].abs()) / 0.70, 0, 1)
        + 0.20 * np.clip(result["relative_strength_30d"] / 0.15, 0, 1)
    )
    reversion_strength = (
        0.45 * np.clip((-result["bollinger_z"] - 1.0) / 1.5, 0, 1)
        + 0.35 * np.clip((0.43 - rsi) / 0.25, 0, 1)
        + 0.20 * np.clip((0.10 - result["trend_50"].abs()) / 0.10, 0, 1)
    )
    result["strategy_signal_strength"] = np.select(
        [breakout, trend_pullback, mean_reversion],
        [breakout_strength, pullback_strength, reversion_strength],
        default=0.0,
    )
    return result


def add_strategy_statistics(
    panel: pd.DataFrame,
    latest: pd.DataFrame,
    config: StrategyConfig,
    round_trip_cost_fraction: float,
) -> pd.DataFrame:
    """Attach shrinkage estimates for the currently selected chart strategy.

    Asset-specific observations are blended with the pooled strategy history so
    a tiny sample cannot masquerade as a precise edge.
    """

    history = panel.dropna(subset=["forward_return", "target_up"]).copy()
    history["strategy_net_return"] = (history["forward_return"] - round_trip_cost_fraction).clip(-0.95, 2.0)
    rows: list[dict[str, object]] = []
    prior_strength = 12.0

    for row in latest.itertuples(index=False):
        strategy = str(row.chart_strategy)
        if strategy == CASH_STRATEGY:
            rows.append(
                {
                    "asset_id": str(row.asset_id),
                    "strategy_asset_samples": 0,
                    "strategy_pooled_samples": 0,
                    "strategy_win_rate": 0.5,
                    "strategy_expected_net_return": 0.0,
                    "strategy_confirmed": False,
                    "strategy_gate_reason": "no eligible chart setup",
                }
            )
            continue

        pooled = history[history["chart_strategy"] == strategy]
        own = pooled[pooled["asset_id"] == row.asset_id]
        pooled_n = len(pooled)
        own_n = len(own)
        pooled_win = float(pooled["target_up"].mean()) if pooled_n else 0.5
        pooled_expectancy = float(pooled["strategy_net_return"].mean()) if pooled_n else 0.0
        own_wins = float(own["target_up"].sum()) if own_n else 0.0
        own_return_sum = float(own["strategy_net_return"].sum()) if own_n else 0.0
        smoothed_win = (own_wins + prior_strength * pooled_win) / (own_n + prior_strength)
        smoothed_expectancy = (own_return_sum + prior_strength * pooled_expectancy) / (own_n + prior_strength)

        reasons = []
        if own_n < config.minimum_asset_observations:
            reasons.append("too few asset observations")
        if pooled_n < config.minimum_pooled_observations:
            reasons.append("too few pooled observations")
        if smoothed_win < config.minimum_smoothed_win_rate:
            reasons.append("historical win rate below gate")
        if smoothed_expectancy <= config.minimum_expected_net_return:
            reasons.append("historical net expectancy below gate")
        confirmed = not reasons
        rows.append(
            {
                "asset_id": str(row.asset_id),
                "strategy_asset_samples": own_n,
                "strategy_pooled_samples": pooled_n,
                "strategy_win_rate": float(smoothed_win),
                "strategy_expected_net_return": float(smoothed_expectancy),
                "strategy_confirmed": confirmed,
                "strategy_gate_reason": "strategy gate passed" if confirmed else "; ".join(reasons),
            }
        )

    statistics = pd.DataFrame(rows)
    return latest.merge(statistics, on="asset_id", how="left", validate="one_to_one")
