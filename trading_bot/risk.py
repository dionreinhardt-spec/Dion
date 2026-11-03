from __future__ import annotations

from dataclasses import asdict, dataclass

import numpy as np
import pandas as pd

from .config import RiskConfig, StrategyConfig


@dataclass(slots=True)
class TradePlan:
    asset_id: str
    symbol: str
    price: float
    probability_up: float
    action: str
    risk_tier: str
    position_fraction: float
    notional: float
    stop_price: float
    target_price: float
    rationale: str
    strategy: str = "UNSPECIFIED"
    market_regime: str = "UNSPECIFIED"
    strategy_signal_strength: float = 0.0
    strategy_win_rate: float = 0.5
    strategy_expected_net_return: float = 0.0
    strategy_samples: int = 0
    holding_days: int = 0

    def to_dict(self) -> dict[str, object]:
        return asdict(self)


def classify_risk_tier(market_cap: float, turnover: float, annualized_volatility: float) -> str:
    if market_cap < 250_000_000 or annualized_volatility > 1.25 or turnover > 0.35:
        return "speculative"
    if market_cap < 2_000_000_000 or annualized_volatility > 0.85:
        return "high"
    return "core"


def build_trade_plans(
    scored: pd.DataFrame,
    risk: RiskConfig,
    probability_threshold: float,
    model_quality_pass: bool,
    equity: float,
    strategy_config: StrategyConfig | None = None,
    holding_days: int = 7,
    backtest_quality_pass: bool = True,
) -> list[TradePlan]:
    strategy_config = strategy_config or StrategyConfig(require_confirmation=False)
    candidates = scored.sort_values("probability_up", ascending=False)
    plans: list[TradePlan] = []
    allocated = 0.0
    open_slots = risk.max_positions
    for row in candidates.itertuples(index=False):
        strategy_name = str(getattr(row, "chart_strategy", "TREND_PULLBACK"))
        market_regime = str(getattr(row, "market_regime", "UNSPECIFIED"))
        signal_strength = float(getattr(row, "strategy_signal_strength", 0.5))
        strategy_win_rate = float(getattr(row, "strategy_win_rate", 0.5))
        strategy_expectancy = float(getattr(row, "strategy_expected_net_return", 0.0))
        strategy_samples = int(getattr(row, "strategy_asset_samples", 0))
        strategy_confirmed = bool(getattr(row, "strategy_confirmed", True))
        strategy_gate_reason = str(getattr(row, "strategy_gate_reason", "strategy statistics unavailable"))
        daily_volatility = float(row.volatility_20) / np.sqrt(365)
        stop_multiplier = {
            "MOMENTUM_BREAKOUT": 1.75,
            "TREND_PULLBACK": risk.stop_volatility_multiple,
            "RANGE_MEAN_REVERSION": 1.50,
        }.get(strategy_name, risk.stop_volatility_multiple)
        stop_fraction = float(
            np.clip(stop_multiplier * daily_volatility, risk.min_stop_fraction, risk.max_stop_fraction)
        )
        strategy_risk_multiplier = {
            "MOMENTUM_BREAKOUT": 0.75,
            "TREND_PULLBACK": 1.00,
            "RANGE_MEAN_REVERSION": 0.65,
        }.get(strategy_name, 0.0)
        raw_position = (risk.risk_per_trade / stop_fraction) * strategy_risk_multiplier
        remaining = max(0.0, risk.max_portfolio_exposure - allocated)
        position_fraction = min(raw_position, risk.max_position_fraction, remaining)
        tier = classify_risk_tier(float(row.market_cap), float(row.turnover), float(row.volatility_20))
        if tier == "speculative":
            position_fraction *= 0.5

        if not model_quality_pass:
            action = "NO_TRADE_MODEL_GATE"
            position_fraction = 0.0
        elif not backtest_quality_pass:
            action = "NO_TRADE_BACKTEST_GATE"
            position_fraction = 0.0
        elif float(row.probability_up) < probability_threshold:
            action = "WATCH_PROBABILITY"
            position_fraction = 0.0
        elif strategy_name == "CASH_DEFENSIVE":
            action = "WATCH_NO_SETUP"
            position_fraction = 0.0
        elif strategy_config.require_confirmation and not strategy_confirmed:
            action = "WATCH_STRATEGY_GATE"
            position_fraction = 0.0
        elif open_slots <= 0:
            action = "WATCH_POSITION_LIMIT"
            position_fraction = 0.0
        elif position_fraction <= 0:
            action = "WATCH_EXPOSURE_LIMIT"
        else:
            action = "PAPER_BUY"
            allocated += position_fraction
            open_slots -= 1

        price = float(row.close)
        reward_risk = {
            "MOMENTUM_BREAKOUT": max(2.5, risk.reward_risk_ratio),
            "TREND_PULLBACK": risk.reward_risk_ratio,
            "RANGE_MEAN_REVERSION": min(1.5, risk.reward_risk_ratio),
        }.get(strategy_name, risk.reward_risk_ratio)
        target_price = price * (1 + reward_risk * stop_fraction)
        if strategy_name == "RANGE_MEAN_REVERSION":
            target_price = max(target_price, float(getattr(row, "sma_20", price)))
        rationale = (
            f"{strategy_name} in {market_regime}; p(up)={float(row.probability_up):.1%}; "
            f"strategy win={strategy_win_rate:.1%}, net expectancy={strategy_expectancy:+.2%}; "
            f"7d momentum={float(row.ret_7d):+.1%}; "
            f"relative strength={float(row.relative_strength_7d):+.1%}; RSI={float(row.rsi_14) * 100:.0f}; "
            f"annualized vol={float(row.volatility_20):.0%}; gate={strategy_gate_reason}"
        )
        plans.append(
            TradePlan(
                asset_id=str(row.asset_id),
                symbol=str(row.symbol),
                price=price,
                probability_up=float(row.probability_up),
                action=action,
                risk_tier=tier,
                position_fraction=position_fraction,
                notional=equity * position_fraction,
                stop_price=price * (1 - stop_fraction),
                target_price=target_price,
                rationale=rationale,
                strategy=strategy_name,
                market_regime=market_regime,
                strategy_signal_strength=signal_strength,
                strategy_win_rate=strategy_win_rate,
                strategy_expected_net_return=strategy_expectancy,
                strategy_samples=strategy_samples,
                holding_days=holding_days,
            )
        )
    return plans
