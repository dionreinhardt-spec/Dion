"""Paper execution only. No private keys, wallet permissions or live order API."""
import asyncio
import copy
import time
import uuid
from datetime import datetime, timezone
from zoneinfo import ZoneInfo
from .analytics import clamp


class RiskRejected(ValueError):
    pass


class PaperBroker:
    def __init__(self, settings, store, clock=time.time):
        self.settings, self.store = settings, store
        self.clock = clock
        self.lock = asyncio.Lock()
        self.state = {}

    async def start(self):
        today = datetime.fromtimestamp(self.clock(), ZoneInfo(self.settings.risk_timezone)).date().isoformat()
        initial = self.settings.paper_initial_cash_usd
        self.state = await self.store.get("paper", {"cash": initial, "initial_cash": initial, "positions": {},
                                                   "journal": [], "orders": {}, "kill_switch": False,
                                                   "day": today, "day_start_equity": initial,
                                                   "peak_equity": initial, "breaker": None})

    def equity(self, snapshots: dict) -> float:
        equity = self.state["cash"]
        for p in self.state["positions"].values():
            snap = snapshots.get(p["token"], {})
            price = snap.get("price_usd") or p["last_mark"]
            equity += p["quantity"] * price
        return equity

    def portfolio(self, snapshots: dict) -> dict:
        equity = self.equity(snapshots)
        positions = []
        for p in self.state["positions"].values():
            snap = snapshots.get(p["token"], {})
            mark = snap.get("price_usd") or p["last_mark"]
            stale = snap.get("trade_age_s") is None or snap["trade_age_s"] > self.settings.max_trade_age_s
            value = p["quantity"] * mark
            positions.append({**p, "mark": mark, "mark_stale": stale, "value_usd": value,
                              "unrealized_pnl_usd": value - p["cost_basis"],
                              "return_pct": (value / p["cost_basis"] - 1) * 100,
                              "exit_warning": "Daten veraltet; kein belastbarer Fill" if stale else None})
        exposure = sum(p["value_usd"] for p in positions)
        realized = sum(j.get("realized_pnl_usd", 0) for j in self.state["journal"])
        return {"cash_usd": self.state["cash"], "equity_usd": equity, "initial_cash_usd": self.state["initial_cash"],
                "exposure_usd": exposure, "net_pnl_usd": equity - self.state["initial_cash"],
                "realized_pnl_usd": realized, "positions": positions,
                "kill_switch": self.state["kill_switch"], "breaker": self.state["breaker"],
                "journal": self.state["journal"][-200:], "mode": "paper", "live_execution_available": False,
                "valuation": "Unrealisierte Werte vor modellierten Exit-Kosten; veraltete Marken gekennzeichnet"}

    def check(self, snapshots: dict):
        if self.state["kill_switch"]:
            raise RiskRejected("Kill Switch aktiv")
        if self.state["breaker"]:
            raise RiskRejected(self.state["breaker"])
        eq = self.equity(snapshots)
        if eq <= self.state["day_start_equity"] * (1 - self.settings.max_daily_loss_pct / 100):
            raise RiskRejected("Tagesverlust-Limit erreicht")
        if eq <= self.state["peak_equity"] * (1 - self.settings.max_drawdown_pct / 100):
            raise RiskRejected("Drawdown-Limit erreicht")

    def validate_mark(self, snap: dict):
        elapsed = max(0, self.clock() - snap.get("evaluated_at", 0))
        if not snap.get("price_usd") or snap.get("trade_age_s") is None or snap["trade_age_s"] + elapsed > self.settings.max_trade_age_s:
            raise RiskRejected("Kein frischer Marktpreis")
        if snap.get("metadata_age_s") is None or snap["metadata_age_s"] + elapsed > self.settings.max_price_age_s:
            raise RiskRejected("Keine frischen Liquiditätsdaten")

    def cost_model(self, snap: dict, notional: float):
        liquidity = snap.get("market", {}).get("liquidity_usd", 0) if snap.get("market") else 0
        if liquidity <= 0:
            raise RiskRejected("Ausführbare Liquidität unbekannt")
        # Conservative, explicit proxy, not a DEX route quote or depth guarantee.
        impact = notional / (liquidity / 2 + notional)
        slip = self.settings.modeled_slippage_bps / 10000 + impact
        if impact * 100 > self.settings.max_price_impact_pct:
            raise RiskRejected("Modellierter Price Impact überschreitet das Limit")
        if slip * 10000 > self.settings.max_slippage_bps:
            raise RiskRejected("Modellierte Slippage überschreitet das Limit")
        fee = notional * self.settings.modeled_fee_bps / 10000 + self.settings.modeled_priority_fee_usd
        return slip, fee, impact

    def plan(self, snap: dict, snapshots: dict) -> dict:
        s = self.settings
        eq = self.equity(snapshots)
        price = snap.get("price_usd")
        liquidity = snap.get("market", {}).get("liquidity_usd", 0) if snap.get("market") else 0
        exposure = self.portfolio(snapshots)["exposure_usd"]
        budget = eq * s.risk_per_trade_pct / 100
        loss_fraction = s.stop_pct / 100 + 2 * (s.max_slippage_bps + s.modeled_fee_bps) / 10000
        impact_cap = liquidity / 2 * (s.max_price_impact_pct / 100) / (1 - s.max_price_impact_pct / 100)
        remaining = eq * s.max_exposure_pct / 100 - exposure
        cash_cap = max(0, self.state["cash"] - s.modeled_priority_fee_usd) / (1 + s.modeled_fee_bps / 10000)
        max_size = max(0, min((budget - 2 * s.modeled_priority_fee_usd) / loss_fraction,
                             eq * s.max_position_pct / 100, remaining, cash_cap, impact_cap))
        # Slippage limits may be stricter than the independent impact cap.
        slip_impact = max(0, (s.max_slippage_bps - s.modeled_slippage_bps) / 10000)
        max_size = min(max_size, liquidity / 2 * slip_impact / (1 - slip_impact))
        allowed = snap.get("status") == "ENTRY_CANDIDATE" and max_size > 1
        reasons = list(snap.get("blockers", []))
        try:
            self.check(snapshots)
        except RiskRejected as exc:
            allowed = False
            reasons.append(str(exc))
        if len(self.state["positions"]) >= s.max_positions or snap["token"] in self.state["positions"]:
            allowed = False
            reasons.append("Positionslimit erreicht oder Position bereits offen")
        return {"allowed": allowed, "reasons": reasons, "max_notional_usd": round(max_size, 2),
                "risk_budget_usd": round(budget, 2), "entry_zone": [price * .99, price * 1.01] if price else None,
                "stop_price": price * (1 - s.stop_pct / 100) if price else None,
                "take_profit": [price * 1.2, price * 1.4] if price else [], "trailing_stop_pct": s.stop_pct,
                "max_hold_s": s.paper_max_hold_s, "fee_bps_per_side": s.modeled_fee_bps,
                "slippage_bps_base": s.modeled_slippage_bps, "priority_fee_usd_per_side": s.modeled_priority_fee_usd,
                "execution": "Paper-Modell; keine zugesicherte Ausführbarkeit oder Stop-Garantie"}

    async def _persist(self, candidate: dict):
        # Do not expose an acknowledged in-memory fill if the durable write failed.
        await self.store.set("paper", candidate)
        self.state = candidate

    async def open(self, request, snap: dict, snapshots: dict):
        async with self.lock:
            key = request.idempotency_key
            fingerprint = {"action": "buy", "token": request.token, "notional": request.notional_usd}
            if key in self.state["orders"]:
                prior = self.state["orders"][key]
                if prior["request"] != fingerprint:
                    raise RiskRejected("Idempotency-Key mit anderem Auftrag wiederverwendet")
                return prior["result"]
            self.check(snapshots)
            self.validate_mark(snap)
            plan = self.plan(snap, snapshots)
            if not plan["allowed"]:
                raise RiskRejected("Kein freigegebener Einstieg: " + "; ".join(plan["reasons"] or ["Entry-Bedingungen nicht erfüllt"]))
            if request.notional_usd > plan["max_notional_usd"]:
                raise RiskRejected("Positionsgröße überschreitet das Risikolimit")
            slip, fee, impact = self.cost_model(snap, request.notional_usd)
            fill = snap["price_usd"] * (1 + slip)
            now = self.clock()
            position = {"id": str(uuid.uuid4()), "token": request.token, "symbol": snap["symbol"], "opened_at": now,
                        "quantity": request.notional_usd / fill, "entry_price": fill,
                        "cost_basis": request.notional_usd + fee, "last_mark": snap["price_usd"], "high_water": fill,
                        "stop_price": fill * (1 - self.settings.stop_pct / 100), "tp1_done": False, "tp2_done": False}
            result = {"id": position["id"], "side": "buy", "token": request.token, "timestamp": now,
                      "fill_price": fill, "signal_price": snap["price_usd"], "notional_usd": request.notional_usd,
                      "quantity": position["quantity"], "fee_usd": fee, "modeled_slippage_bps": slip * 10000,
                      "modeled_impact_pct": impact * 100, "mode": "paper"}
            state = copy.deepcopy(self.state)
            state["cash"] -= request.notional_usd + fee
            state["positions"][request.token] = position
            state["journal"].append(result)
            state["orders"][key] = {"request": fingerprint, "result": result}
            await self._persist(state)
            return result

    async def close(self, token: str, fraction: float, key: str, snap: dict, reason="manual"):
        async with self.lock:
            return await self._close_unlocked(token, fraction, key, snap, reason)

    async def _close_unlocked(self, token, fraction, key, snap, reason):
        fingerprint = {"action": "sell", "token": token, "fraction": fraction}
        if key in self.state["orders"]:
            prior = self.state["orders"][key]
            if prior["request"] != fingerprint:
                raise RiskRejected("Idempotency-Key-Konflikt")
            return prior["result"]
        p = self.state["positions"].get(token)
        if not p:
            raise RiskRejected("Position nicht vorhanden")
        if not snap or not snap.get("price_usd") or snap.get("trade_age_s") is None or snap["trade_age_s"] > self.settings.max_trade_age_s:
            raise RiskRejected("Kein frischer Exit-Preis; Fill wird nicht erfunden")
        if snap.get("metadata_age_s") is None or snap["metadata_age_s"] > self.settings.max_price_age_s:
            raise RiskRejected("Veraltete Exit-Liquidität")
        self.validate_mark(snap)
        quantity = p["quantity"] * fraction
        slip, _, impact = self.cost_model(snap, quantity * snap["price_usd"])
        fill = snap["price_usd"] * (1 - slip)
        gross = quantity * fill
        fee = gross * self.settings.modeled_fee_bps / 10000 + self.settings.modeled_priority_fee_usd
        cost = p["cost_basis"] * fraction
        result = {"id": str(uuid.uuid4()), "side": "sell", "token": token, "timestamp": self.clock(), "reason": reason,
                  "fill_price": fill, "signal_price": snap["price_usd"], "quantity": quantity,
                  "notional_usd": gross, "fee_usd": fee, "realized_pnl_usd": gross - fee - cost,
                  "realized_return": (gross - fee) / cost - 1,
                  "modeled_slippage_bps": slip * 10000, "modeled_impact_pct": impact * 100, "mode": "paper"}
        state = copy.deepcopy(self.state)
        state["cash"] += gross - fee
        if fraction >= 1 - 1e-12:
            del state["positions"][token]
        else:
            state["positions"][token]["quantity"] -= quantity
            state["positions"][token]["cost_basis"] -= cost
            if reason == "tp1":
                state["positions"][token]["tp1_done"] = True
            if reason == "tp2":
                state["positions"][token]["tp2_done"] = True
        state["journal"].append(result)
        state["orders"][key] = {"request": fingerprint, "result": result}
        await self._persist(state)
        return result

    async def tick(self, snapshots: dict, now: float):
        async with self.lock:
            state = copy.deepcopy(self.state)
            equity = self.equity(snapshots)
            today = datetime.fromtimestamp(now, ZoneInfo(self.settings.risk_timezone)).date().isoformat()
            if state["day"] != today:
                state.update(day=today, day_start_equity=equity)
                if state["breaker"] == "Tagesverlust-Limit erreicht":
                    state["breaker"] = None
            state["peak_equity"] = max(state["peak_equity"], equity)
            for token, p in state["positions"].items():
                snap = snapshots.get(token, {})
                if snap.get("price_usd") and snap.get("trade_age_s", 999) <= self.settings.max_trade_age_s:
                    p["last_mark"] = snap["price_usd"]
                    p["high_water"] = max(p["high_water"], snap["price_usd"])
            if equity <= state["day_start_equity"] * (1 - self.settings.max_daily_loss_pct / 100):
                state["breaker"] = "Tagesverlust-Limit erreicht"
            if equity <= state["peak_equity"] * (1 - self.settings.max_drawdown_pct / 100):
                state["breaker"] = "Drawdown-Limit erreicht"
            if state != self.state:
                await self._persist(state)
            # Kill Switch freezes automatic actions; manual risk-reducing closes remain possible.
            if self.state["kill_switch"]:
                return
            for token, p in list(self.state["positions"].items()):
                snap = snapshots.get(token, {})
                price = snap.get("price_usd")
                if not price:
                    continue
                reason, fraction = None, 1.
                f15 = snap.get("windows", {}).get("15", {})
                if self.state["breaker"]:
                    reason = "portfolio-breaker"
                elif price <= max(p["stop_price"], p["high_water"] * (1 - self.settings.stop_pct / 100)):
                    reason = "stop-or-trailing"
                elif (snap.get("security") or {}).get("blockers"):
                    reason = "security-emergency"
                elif (f15.get("net_flow_usd") or 0) < -1000 and f15.get("unique_sellers", 0) >= 5:
                    reason = "momentum-invalidated"
                elif now - p["opened_at"] >= self.settings.paper_max_hold_s:
                    reason = "time-exit"
                elif not p["tp1_done"] and price >= p["entry_price"] * 1.2:
                    reason, fraction = "tp1", .5
                elif p["tp1_done"] and not p["tp2_done"] and price >= p["entry_price"] * 1.4:
                    reason, fraction = "tp2", .5
                if reason:
                    try:
                        await self._close_unlocked(token, fraction, f"auto-{p['id']}-{reason}", snap, reason)
                    except RiskRejected:
                        # No synthetic fill when the market cannot be modeled within limits.
                        continue

    async def set_kill(self, active: bool):
        async with self.lock:
            state = copy.deepcopy(self.state)
            state["kill_switch"] = active
            await self._persist(state)
