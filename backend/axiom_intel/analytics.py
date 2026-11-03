"""Transparent heuristics. Missing features contribute zero; no fitted AI claims."""
import math
from collections import Counter, defaultdict
from .models import Trade, Market, Security, WINDOWS

DEFAULT_WEIGHTS = {"capital_inflow": 20, "smart_money": 10, "holder_growth": 5, "volume_acceleration": 10,
                   "liquidity_quality": 10, "social_momentum": 5, "narrative_strength": 5, "price_structure": 10,
                   "wallet_distribution": 10, "market_conditions": 5, "token_security": 5, "execution_costs": 5}


def clamp(v: float, lo=0., hi=1.) -> float:
    return min(hi, max(lo, v))


def flow(events: list[Trade], now: float, seconds: int) -> dict:
    rows = [e for e in events if now - seconds < e.timestamp <= now]
    priced = [e for e in rows if e.usd is not None]
    buys = [e for e in rows if e.side == "buy"]
    sells = [e for e in rows if e.side == "sell"]
    buy_usd = sum(e.usd for e in priced if e.side == "buy")
    sell_usd = sum(e.usd for e in priced if e.side == "sell")
    by_wallet: dict[str, float] = defaultdict(float)
    wallet_sides: dict[str, set] = defaultdict(set)
    for e in priced:
        by_wallet[e.wallet] += e.usd
        wallet_sides[e.wallet].add(e.side)
    gross = buy_usd + sell_usd
    # Round trips are only a suspicion. There is no funding-cluster attribution.
    roundtrip = sum(by_wallet[w] for w, sides in wallet_sides.items() if len(sides) == 2) / gross if gross else 0
    share = max(by_wallet.values(), default=0) / gross if gross else 0
    return {"seconds": seconds, "buys": len(buys), "sells": len(sells), "trades": len(rows),
            "unique_buyers": len({e.wallet for e in buys}), "unique_sellers": len({e.wallet for e in sells}),
            "gross_buy_usd": buy_usd if priced else None, "gross_sell_usd": sell_usd if priced else None,
            "net_flow_usd": buy_usd - sell_usd if priced else None,
            "buy_sell_ratio": len(buys) / len(sells) if sells else None,
            "priced_fraction": len(priced) / len(rows) if rows else 0,
            "max_wallet_volume_share": share, "roundtrip_volume_share": roundtrip,
            "repeat_buyers": sum(v > 1 for v in Counter(e.wallet for e in buys).values()),
            "large_buys_usd": sorted((e.usd for e in priced if e.side == "buy"), reverse=True)[:5]}


def analyze(token: str, events: list[Trade], market: Market | None, security: Security | None,
            settings, now: float, observed_since: float, stream_ok: bool, weights: dict,
            social: dict | None = None) -> dict:
    events = sorted((e for e in events if e.timestamp <= now), key=lambda e: (e.timestamp, e.slot, e.event_index, e.id))
    windows = {str(w): flow(events, now, w) for w in WINDOWS}
    f = windows["30"]
    prior = [e for e in events if now - 60 < e.timestamp <= now - 30 and e.usd is not None]
    previous_vol = sum(e.usd for e in prior)
    gross = (f["gross_buy_usd"] or 0) + (f["gross_sell_usd"] or 0)
    acceleration = gross / previous_vol if previous_vol > 0 else None
    net = f["net_flow_usd"] or 0
    liquidity = market.liquidity_usd if market else None
    last = events[-1] if events else None
    trade_age = max(0, now - last.timestamp) if last else None
    metadata_age = max(0, now - market.received_at) if market else None
    sec_age = max(0, now - security.checked_at) if security else None
    chain_latency = max(0, last.received_at - last.timestamp) if last else None
    concentration = security.largest_observed_owner_share if security else None
    current = [e for e in events if now - 30 < e.timestamp <= now and e.price_usd]
    prior_prices = [e.price_usd for e in events if now - 60 < e.timestamp <= now - 30 and e.price_usd]
    price = current[-1].price_usd if current else None
    change = (price / prior_prices[-1] - 1) if price and prior_prices else None
    inflow_components = {
        "net_to_liquidity": clamp(net / liquidity / .05) if liquidity else 0,
        "independent_addresses": clamp(f["unique_buyers"] / 25),
        "buy_pressure": clamp((f["gross_buy_usd"] or 0) / gross) if gross else 0,
        "persistence": sum((windows[str(w)]["net_flow_usd"] or 0) > 0 for w in (5, 15, 30)) / 3,
        "distribution_penalty": clamp(1 - f["max_wallet_volume_share"]),
        "roundtrip_penalty": clamp(1 - f["roundtrip_volume_share"]),
    }
    inflow_score = 100 * sum(inflow_components.values()) / len(inflow_components)
    estimated_cost = (settings.modeled_fee_bps + settings.modeled_slippage_bps) / 10000
    features = {
        "capital_inflow": inflow_score / 100 if f["priced_fraction"] == 1 and f["trades"] else None,
        "smart_money": None, "holder_growth": None,
        "volume_acceleration": clamp((acceleration - 1) / 2) if acceleration is not None else None,
        "liquidity_quality": clamp(liquidity / 100000) if liquidity is not None else None,
        "social_momentum": social.get("score") if social and social.get("eligible") else None,
        "narrative_strength": None,
        "price_structure": clamp(change / .08) if change is not None else None,
        "wallet_distribution": clamp(1 - concentration / settings.max_largest_owner_share) if concentration is not None else None,
        "market_conditions": None,
        "token_security": 0 if security and security.blockers else (.65 if security else None),
        "execution_costs": clamp(1 - estimated_cost / .05) if market else None,
    }
    contributions = {k: round(weights[k] * (features[k] or 0), 3) for k in weights}
    score = round(sum(contributions.values()), 1)
    completeness = sum(weights[k] for k, v in features.items() if v is not None) / sum(weights.values())
    span = max(0, now - observed_since)
    warmup = span >= settings.min_warmup_s
    blockers = list(security.blockers) if security else ["Token-Sicherheitsprüfung fehlt"]
    if any(e.schema_warning for e in events if now - 60 < e.timestamp <= now):
        blockers.append("IDL-Schema weicht von aktuellen Mainnet-Events ab; bekannte Felder nur zur Beobachtung")
    if not stream_ok:
        blockers.append("Stream unterbrochen oder Aufwärmphase nach Datenlücke")
    if not warmup:
        blockers.append("Mindestens 60 Sekunden Beobachtung benötigt")
    if trade_age is None or trade_age > settings.max_trade_age_s:
        blockers.append("Keine frischen On-Chain-Trades")
    if chain_latency is None or chain_latency > settings.max_trade_age_s:
        blockers.append("Event-Latenz überschreitet das Limit")
    if metadata_age is None or metadata_age > settings.max_price_age_s:
        blockers.append("DEX-Metadaten fehlen oder sind veraltet")
    if sec_age is None or sec_age > settings.max_security_age_s:
        blockers.append("Sicherheitsdaten fehlen oder sind veraltet")
    if liquidity is None or liquidity < settings.min_liquidity_usd:
        blockers.append("Liquidität unter Mindestgrenze oder unbekannt")
    if concentration is None or concentration > settings.max_largest_owner_share:
        blockers.append("Beobachtete Wallet-Konzentration zu hoch oder unbekannt")
    if f["priced_fraction"] < 1:
        blockers.append("USD-Bewertung der Trades unvollständig")
    if f["max_wallet_volume_share"] > settings.max_single_wallet_share:
        blockers.append("Einzelne Wallet dominiert das Volumen")
    if f["roundtrip_volume_share"] > .65:
        blockers.append("Hoher Roundtrip-Anteil; mögliche künstliche Aktivität")
    # A source disagreement is material, not an invitation to select a better price.
    if market and price and abs(price / market.price_usd - 1) > .15:
        blockers.append("Preisabweichung zwischen On-Chain-Trade und DEX > 15 %")
    conditions = {"positive_5s": (windows["5"]["net_flow_usd"] or 0) > 0,
                  "positive_15s": (windows["15"]["net_flow_usd"] or 0) > 0,
                  "positive_30s": net > 0, "buyers": f["unique_buyers"] >= settings.min_buyers_30s,
                  "volume": acceleration is not None and acceleration >= 1.5,
                  "price": change is not None and 0 < change <= .4, "score": score >= settings.signal_score_threshold}
    status = "BLOCKED" if blockers else ("ENTRY_CANDIDATE" if all(conditions.values()) else "WATCH")
    positives = []
    if net > 0:
        positives.append(f"30s-Nettofluss +${net:,.0f} in beobachteten Trades")
    if f["unique_buyers"] >= settings.min_buyers_30s:
        positives.append(f"{f['unique_buyers']} verschiedene Käufer-Adressen in 30s; Unabhängigkeit ungeprüft")
    if acceleration and acceleration > 1:
        positives.append(f"Volumen {acceleration:.2f}× gegenüber den vorherigen 30s")
    warnings = ["Nicht kalibrierter Heuristik-Score; kein Renditenachweis", "Vollständige Holder-, Insider- und Funding-Daten fehlen"]
    if f["roundtrip_volume_share"] > .3:
        warnings.append("Roundtrip-Aktivität erhöht; Heuristik ist kein Wash-Trading-Nachweis")
    freshness = min(1, settings.max_trade_age_s / max(trade_age if trade_age is not None else 9999, 1)) if last else 0
    confidence = round(100 * completeness * freshness * clamp(span / 60) * (1 if stream_ok else .1), 1)
    return {"token": token, "chain": "solana", "symbol": market.symbol if market else token[:6],
            "name": market.name if market else "Nicht angereichert", "venue": last.venue if last else None,
            "price_usd": price, "market": market.model_dump() if market else None,
            "security": security.model_dump() if security else None,
            "windows": windows, "score": score, "score_kind": "transparent-heuristic-v1",
            "contributions": contributions, "features": features, "data_completeness_pct": round(completeness * 100, 1),
            "confidence": confidence, "scam_probability": None, "risk_score": min(100, 40 + len(set(blockers)) * 9),
            "risk_score_kind": "heuristic; keine kalibrierte Betrugswahrscheinlichkeit",
            "inflow_score": round(inflow_score, 1), "inflow_components": inflow_components,
            "volume_acceleration": acceleration, "price_change_30s": change, "status": status,
            "strategy": "momentum-v1", "conditions": conditions, "blockers": sorted(set(blockers)),
            "positives": positives, "warnings": warnings,
            "trade_age_s": trade_age, "chain_latency_s": chain_latency, "metadata_age_s": metadata_age,
            "source_price_timestamp": None, "security_age_s": sec_age, "observed_seconds": round(span, 1),
            "window_coverage": {str(w): {"observed_seconds": min(w, round(span, 1)), "complete": span >= w and stream_ok} for w in WINDOWS},
            "last_event_at": last.timestamp if last else None, "evaluated_at": now,
            "axiom_url": "https://axiom.trade/pulse", "axiom_link_kind": "documented-pulse-and-contract-search",
            "holders": None, "new_holders": None, "smart_money_entries": None}
