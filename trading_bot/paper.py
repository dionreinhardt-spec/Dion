from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime
from pathlib import Path

from .config import RiskConfig
from .risk import TradePlan


@dataclass(slots=True)
class Position:
    asset_id: str
    symbol: str
    quantity: float
    entry_price: float
    stop_price: float
    target_price: float
    opened_at: str
    strategy: str = "UNSPECIFIED"
    holding_days: int = 7


@dataclass(slots=True)
class PaperPortfolio:
    cash: float
    positions: dict[str, Position] = field(default_factory=dict)
    transactions: list[dict[str, object]] = field(default_factory=list)

    @classmethod
    def load(cls, path: str | Path, starting_cash: float) -> "PaperPortfolio":
        file_path = Path(path)
        if not file_path.exists():
            return cls(cash=starting_cash)
        raw = json.loads(file_path.read_text(encoding="utf-8"))
        positions = {key: Position(**value) for key, value in raw.get("positions", {}).items()}
        return cls(cash=float(raw["cash"]), positions=positions, transactions=list(raw.get("transactions", [])))

    def save(self, path: str | Path) -> None:
        payload = {
            "cash": self.cash,
            "positions": {key: asdict(value) for key, value in self.positions.items()},
            "transactions": self.transactions,
        }
        Path(path).write_text(json.dumps(payload, indent=2), encoding="utf-8")

    def equity(self, prices: dict[str, float]) -> float:
        return self.cash + sum(position.quantity * prices.get(asset_id, position.entry_price) for asset_id, position in self.positions.items())

    def mark_and_exit(self, prices: dict[str, float], risk: RiskConfig) -> list[str]:
        messages = []
        for asset_id, position in list(self.positions.items()):
            price = prices.get(asset_id)
            if price is None:
                continue
            reason = None
            if price <= position.stop_price:
                reason = "stop"
            elif price >= position.target_price:
                reason = "target"
            else:
                try:
                    opened_at = datetime.fromisoformat(position.opened_at)
                    if opened_at.tzinfo is None:
                        opened_at = opened_at.replace(tzinfo=UTC)
                    if (datetime.now(UTC) - opened_at).days >= position.holding_days:
                        reason = "time_stop"
                except ValueError:
                    pass
            if reason:
                gross = position.quantity * price
                fee = gross * (risk.fee_bps_per_side + risk.slippage_bps_per_side) / 10_000
                self.cash += gross - fee
                self.transactions.append(
                    {
                        "time": datetime.now(UTC).isoformat(),
                        "side": "SELL",
                        "asset_id": asset_id,
                        "symbol": position.symbol,
                        "quantity": position.quantity,
                        "price": price,
                        "fee_and_slippage": fee,
                        "reason": reason,
                    }
                )
                del self.positions[asset_id]
                messages.append(f"PAPER_SELL {position.symbol} at {price:.8g} ({reason})")
        return messages

    def execute_plans(self, plans: list[TradePlan], risk: RiskConfig, prices: dict[str, float]) -> list[str]:
        messages = []
        equity = self.equity(prices)
        invested_value = sum(
            position.quantity * prices.get(asset_id, position.entry_price)
            for asset_id, position in self.positions.items()
        )
        remaining_exposure_value = max(0.0, equity * risk.max_portfolio_exposure - invested_value)
        for plan in plans:
            if plan.action != "PAPER_BUY" or plan.asset_id in self.positions:
                continue
            if len(self.positions) >= risk.max_positions:
                break
            notional = min(
                plan.notional,
                self.cash * 0.98,
                equity * risk.max_position_fraction,
                remaining_exposure_value,
            )
            if notional <= 0:
                continue
            cost_rate = (risk.fee_bps_per_side + risk.slippage_bps_per_side) / 10_000
            fee = notional * cost_rate
            quantity = (notional - fee) / plan.price
            self.cash -= notional
            remaining_exposure_value -= notional
            self.positions[plan.asset_id] = Position(
                asset_id=plan.asset_id,
                symbol=plan.symbol,
                quantity=quantity,
                entry_price=plan.price,
                stop_price=plan.stop_price,
                target_price=plan.target_price,
                opened_at=datetime.now(UTC).isoformat(),
                strategy=plan.strategy,
                holding_days=plan.holding_days,
            )
            self.transactions.append(
                {
                    "time": datetime.now(UTC).isoformat(),
                    "side": "BUY",
                    "asset_id": plan.asset_id,
                    "symbol": plan.symbol,
                    "quantity": quantity,
                    "price": plan.price,
                    "fee_and_slippage": fee,
                    "reason": plan.rationale,
                }
            )
            messages.append(f"PAPER_BUY {plan.symbol}: {quantity:.6g} at {plan.price:.8g}")
        return messages
