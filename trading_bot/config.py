from __future__ import annotations

from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

import yaml


@dataclass(slots=True)
class MarketConfig:
    vs_currency: str = "usd"
    universe_size: int = 25
    lookback_days: int = 365
    horizon_days: int = 7
    min_market_cap: float = 50_000_000
    min_daily_volume: float = 1_000_000
    request_delay_seconds: float = 1.3
    cache_ttl_seconds: int = 3_600


@dataclass(slots=True)
class ModelConfig:
    minimum_training_days: int = 150
    minimum_validation_rows: int = 100
    probability_threshold: float = 0.60
    probability_cap_low: float = 0.10
    probability_cap_high: float = 0.85
    shrinkage_to_base_rate: float = 0.25
    calibration_bins: int = 8


@dataclass(slots=True)
class StrategyConfig:
    minimum_asset_observations: int = 5
    minimum_pooled_observations: int = 40
    minimum_smoothed_win_rate: float = 0.50
    minimum_expected_net_return: float = 0.0
    require_confirmation: bool = True
    high_volatility_cutoff: float = 1.25
    chart_lookback_days: int = 120
    minimum_backtest_trades: int = 20


@dataclass(slots=True)
class RiskConfig:
    starting_cash: float = 100_000
    risk_per_trade: float = 0.005
    max_position_fraction: float = 0.10
    max_portfolio_exposure: float = 0.40
    max_positions: int = 5
    min_stop_fraction: float = 0.04
    max_stop_fraction: float = 0.18
    stop_volatility_multiple: float = 2.0
    reward_risk_ratio: float = 2.0
    fee_bps_per_side: float = 10
    slippage_bps_per_side: float = 15

    @property
    def round_trip_cost_fraction(self) -> float:
        return 2 * (self.fee_bps_per_side + self.slippage_bps_per_side) / 10_000


@dataclass(slots=True)
class AppConfig:
    market: MarketConfig = field(default_factory=MarketConfig)
    model: ModelConfig = field(default_factory=ModelConfig)
    strategy: StrategyConfig = field(default_factory=StrategyConfig)
    risk: RiskConfig = field(default_factory=RiskConfig)

    def validate(self) -> None:
        if not 5 <= self.market.universe_size <= 250:
            raise ValueError("universe_size must be between 5 and 250")
        if self.market.lookback_days < self.model.minimum_training_days + self.market.horizon_days + 30:
            raise ValueError("lookback_days is too short for training, validation and the target horizon")
        if not 0.5 < self.model.probability_threshold < 1:
            raise ValueError("probability_threshold must be between 0.5 and 1")
        if self.strategy.minimum_asset_observations < 1:
            raise ValueError("minimum_asset_observations must be positive")
        if self.strategy.minimum_pooled_observations < self.strategy.minimum_asset_observations:
            raise ValueError("minimum_pooled_observations must be at least minimum_asset_observations")
        if not 0 <= self.strategy.minimum_smoothed_win_rate <= 1:
            raise ValueError("minimum_smoothed_win_rate must be between 0 and 1")
        if self.strategy.high_volatility_cutoff <= 0:
            raise ValueError("high_volatility_cutoff must be positive")
        if self.strategy.chart_lookback_days < 30:
            raise ValueError("chart_lookback_days must be at least 30")
        if self.strategy.minimum_backtest_trades < 5:
            raise ValueError("minimum_backtest_trades must be at least 5")
        if not 0 < self.risk.risk_per_trade <= 0.02:
            raise ValueError("risk_per_trade must be in (0, 0.02]")
        if not 0 < self.risk.max_position_fraction <= 0.25:
            raise ValueError("max_position_fraction must be in (0, 0.25]")
        if not 0 < self.risk.max_portfolio_exposure <= 1:
            raise ValueError("max_portfolio_exposure must be in (0, 1]")

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def _merge_dataclass(instance: Any, values: dict[str, Any]) -> Any:
    known = set(instance.__dataclass_fields__)
    unknown = set(values) - known
    if unknown:
        raise ValueError(f"Unknown config keys for {type(instance).__name__}: {sorted(unknown)}")
    for key, value in values.items():
        setattr(instance, key, value)
    return instance


def load_config(path: str | Path | None = None) -> AppConfig:
    config = AppConfig()
    if path:
        raw = yaml.safe_load(Path(path).read_text(encoding="utf-8")) or {}
        allowed = {"market", "model", "strategy", "risk"}
        unknown = set(raw) - allowed
        if unknown:
            raise ValueError(f"Unknown top-level config keys: {sorted(unknown)}")
        _merge_dataclass(config.market, raw.get("market", {}))
        _merge_dataclass(config.model, raw.get("model", {}))
        _merge_dataclass(config.strategy, raw.get("strategy", {}))
        _merge_dataclass(config.risk, raw.get("risk", {}))
    config.validate()
    return config
