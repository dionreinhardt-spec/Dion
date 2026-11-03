"""FIFO metrics on observed swaps only. Never labels partial history Smart Money."""
from collections import defaultdict, deque
from statistics import median
from .models import Trade


def wallet_metrics(events: list[Trade], fee_bps: float = 100) -> list[dict]:
    lots = defaultdict(deque)
    pnl = defaultdict(list)
    tokens = defaultdict(set)
    unpriced = defaultdict(int)
    uncovered = defaultdict(int)
    for e in sorted(events, key=lambda e: (e.timestamp, e.slot, e.event_index, e.id)):
        if not e.usd or e.decimals is None:
            unpriced[e.wallet] += 1
            continue
        qty = e.token_amount_raw / 10**e.decimals
        key = (e.wallet, e.token)
        if e.side == "buy":
            lots[key].append([qty, e.usd * (1 + fee_bps / 10000) / qty, e.timestamp])
        else:
            remaining = qty
            sell_per_unit = e.usd * (1 - fee_bps / 10000) / qty
            while remaining > 1e-12 and lots[key]:
                lot = lots[key][0]
                size = min(remaining, lot[0])
                cost = size * lot[1]
                profit = size * sell_per_unit - cost
                pnl[e.wallet].append({"pnl": profit, "return": profit / cost, "duration": e.timestamp - lot[2],
                                      "cost": cost, "token": e.token})
                tokens[e.wallet].add(e.token)
                lot[0] -= size
                remaining -= size
                if lot[0] <= 1e-12:
                    lots[key].popleft()
            if remaining > 1e-12:
                uncovered[e.wallet] += 1
    out = []
    for wallet, results in pnl.items():
        profits = [r["pnl"] for r in results]
        wins = sum(p > 0 for p in profits)
        gain, loss = sum(max(0, p) for p in profits), -sum(min(0, p) for p in profits)
        equity, peak, dd = 0., 0., 0.
        for p in profits:
            equity += p
            peak = max(peak, equity)
            dd = max(dd, peak - equity)
        out.append({"wallet": wallet, "observed_realized_pnl_usd": sum(profits), "closed_lot_matches": len(profits),
                    "win_rate": wins / len(profits), "average_return": sum(r["return"] for r in results) / len(results),
                    "median_return": median(r["return"] for r in results), "profit_factor": gain / loss if loss else None,
                    "max_observed_drawdown_usd": dd, "median_hold_s": median(r["duration"] for r in results),
                    "average_matched_cost_usd": sum(r["cost"] for r in results) / len(results), "tokens_closed": len(tokens[wallet]),
                    "uncovered_sells": uncovered[wallet], "unpriced_trades": unpriced[wallet],
                    "smart_money_eligible": False, "scope": "Beobachtete Teilhistorie, modellierte Gebühren; Transfers/Funding nicht erfasst"})
    return sorted(out, key=lambda r: r["observed_realized_pnl_usd"], reverse=True)[:50]
