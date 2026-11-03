from math import sqrt
from statistics import mean, stdev


def performance(journal: list[dict], equity_curve: list[tuple[float, float]], initial: float) -> dict:
    exits = [j for j in journal if j["side"] == "sell"]
    pnls = [j["realized_pnl_usd"] for j in exits]
    positive = sum(max(0, p) for p in pnls)
    negative = -sum(min(0, p) for p in pnls)
    peak, drawdown = initial, 0.
    for _, equity in equity_curve:
        peak = max(peak, equity)
        drawdown = max(drawdown, (peak - equity) / peak)
    daily = {}
    for ts, eq in equity_curve:
        daily[int(ts // 86400)] = eq
    vals = [initial] + [daily[k] for k in sorted(daily)]
    returns = [b / a - 1 for a, b in zip(vals, vals[1:]) if a > 0]
    sharpe = mean(returns) / stdev(returns) * sqrt(365) if len(returns) >= 30 and stdev(returns) else None
    return {"exit_fill_count": len(exits), "win_rate_per_exit_fill": sum(p > 0 for p in pnls) / len(pnls) if pnls else None,
            "profit_factor": positive / negative if negative else None,
            "expectancy_usd_per_exit_fill": mean(pnls) if pnls else None,
            "net_pnl_usd": equity_curve[-1][1] - initial if equity_curve else 0,
            "max_drawdown_pct": drawdown * 100, "daily_sharpe_min_30_days": sharpe,
            "modeled_fees_usd": sum(j.get("fee_usd", 0) for j in journal),
            "note": "Teil-Exits zählen einzeln; offene Positionen sind markiert, nicht garantiert liquidiert"}
