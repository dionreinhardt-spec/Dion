"""Causal arrival-time replay of recorded data. No fabricated historical inputs."""
import argparse
import asyncio
import json
from collections import defaultdict
from pathlib import Path
from .analytics import analyze, DEFAULT_WEIGHTS
from .config import Settings
from .models import Trade, Market, Security, PaperRequest
from .paper import PaperBroker, RiskRejected
from .performance import performance


class MemoryStore:
    def __init__(self):
        self.state = {}
    async def get(self, key, default=None):
        return self.state.get(key, default)
    async def set(self, key, value):
        self.state[key] = value


async def replay(records: list[dict], settings: Settings, start: float | None = None,
                 end: float | None = None, latency_s: float = 1., weights=None):
    if latency_s < 0:
        raise ValueError("Latency must be nonnegative")
    weights = weights or DEFAULT_WEIGHTS
    # Data enters the strategy at provider receipt, not at the earlier chain time.
    ordered = sorted(records, key=lambda r: r["available_at"])
    if not ordered:
        return {"status": "no-data", "performance": None, "journal": [], "rejected": 0}
    clock = [ordered[0]["available_at"]]
    broker = PaperBroker(settings, MemoryStore(), clock=lambda:clock[0])
    await broker.start()
    events, markets, security, since = defaultdict(list), {}, {}, {}
    snapshots, pending = {}, {}
    equity_curve = []
    connected, gap = False, clock[0]
    venue_gaps = {}
    rejected, fills = 0, 0
    for row in ordered:
        now = row["available_at"]
        if end is not None and now >= end:
            break
        clock[0] = now
        kind, payload = row["kind"], row["payload"]
        if kind == "feed":
            connected = bool(payload["connected"])
            gap = payload["last_gap"]
            venue_gaps = {v: d["last_gap"] for v, d in payload.get("venues", {}).items()}
        elif kind == "market":
            m = Market.model_validate(payload)
            if m.received_at > now:
                raise ValueError("Future market receipt timestamp")
            markets[m.token] = m
            since.setdefault(m.token, now)
        elif kind == "security":
            sec = Security.model_validate(payload)
            if sec.checked_at > now or (sec.received_at and sec.received_at > now):
                raise ValueError("Future security check")
            security[sec.token] = sec
            since.setdefault(sec.token, now)
            for e in events[sec.token]:
                e.decimals = sec.decimals
        elif kind == "trade":
            e = Trade.model_validate(payload)
            if e.received_at > now or e.timestamp > now or (e.quote_price_at and e.quote_price_at > now):
                raise ValueError("Future trade/quote input detected")
            if e.token in security:
                e.decimals = security[e.token].decimals
            events[e.token].append(e)
            since.setdefault(e.token, now)
        else:
            continue
        for token in set(events) | set(broker.state["positions"]):
            events[token] = [e for e in events[token] if e.timestamp > now - 86400]
            token_gap = max([gap] + [venue_gaps.get(e.venue, gap) for e in events[token] if e.timestamp > now - 60])
            snap = analyze(token, events[token], markets.get(token), security.get(token), settings, now,
                           max(since.get(token, now), token_gap), connected and now - token_gap >= settings.min_warmup_s,
                           weights)
            snapshots[token] = snap
        active_period = start is None or now >= start
        if active_period:
            await broker.tick(snapshots, now)
        # Entry fills require a later observed trade, never the signal's own price.
        if active_period and kind == "trade":
            token = payload["token"]
            snap = snapshots[token]
            if token in pending and now >= pending[token] + latency_s and token not in broker.state["positions"]:
                try:
                    plan = broker.plan(snap, snapshots)
                    await broker.open(PaperRequest(token=token, notional_usd=min(100, plan["max_notional_usd"]),
                                                   idempotency_key=f"replay-{token}-{fills}"), snap, snapshots)
                    fills += 1
                except (RiskRejected, ValueError):
                    rejected += 1
                pending.pop(token, None)
        if active_period:
            for token, snap in snapshots.items():
                if snap["status"] == "ENTRY_CANDIDATE" and token not in broker.state["positions"]:
                    pending.setdefault(token, now)
                elif snap["status"] != "ENTRY_CANDIDATE":
                    pending.pop(token, None)
            equity_curve.append((now, broker.equity(snapshots)))
    result = {"status": "replayed", "performance": performance(broker.state["journal"], equity_curve, settings.paper_initial_cash_usd),
              "journal": broker.state["journal"], "open_positions": broker.portfolio(snapshots)["positions"],
              "equity_curve": equity_curve, "rejected": rejected,
              "method": "arrival-time replay; next-observed-trade entry; modeled costs, no actual DEX quotes",
              "limitations": ["Keine Delisting-/Survivorship-freie Marktabdeckung", "Keine MEV- oder Failure-Rate-Kalibrierung",
                              "Kein historischer Datenanbieter enthalten", "Kein Renditenachweis aus kurzen Aufzeichnungen"],
              "oos_start": start, "end_exclusive": end}
    return result


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("input", type=Path)
    p.add_argument("--out", type=Path, required=True)
    p.add_argument("--oos-start", type=float, help="Unix timestamp: earlier records are warmup only")
    p.add_argument("--end", type=float)
    p.add_argument("--latency-s", type=float, default=1)
    p.add_argument("--walk-forward-days", type=int, default=0,
                   help="Fixed-weight chronological OOS windows; does not optimize parameters")
    args = p.parse_args()
    rows = [json.loads(line) for line in args.input.read_text().splitlines() if line.strip()]
    settings = Settings(mode="offline")
    weights_path = Path(settings.weights_path)
    weights = json.loads(weights_path.read_text()) if weights_path.exists() else DEFAULT_WEIGHTS
    if set(weights) != set(DEFAULT_WEIGHTS) or abs(sum(weights.values()) - 100) > 1e-6 or any(v < 0 for v in weights.values()):
        raise ValueError("Invalid score weights")
    async def run():
        result = await replay(rows, settings, args.oos_start, args.end, args.latency_s, weights)
        if args.walk_forward_days > 0 and rows:
            low = args.oos_start or min(r["available_at"] for r in rows)
            high = args.end or max(r["available_at"] for r in rows) + .001
            step = args.walk_forward_days * 86400
            result["walk_forward"] = []
            while low < high:
                fold = await replay(rows, settings, low, min(high, low + step), args.latency_s, weights)
                result["walk_forward"].append({"from": low, "to": min(high, low + step), "performance": fold.get("performance")})
                low += step
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(json.dumps(result, indent=2, allow_nan=False))
        print(json.dumps(result.get("performance"), indent=2))
    asyncio.run(run())

if __name__ == "__main__":
    main()
