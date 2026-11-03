import time
import asyncio
from collections import defaultdict
from .models import Market, Security, TOKEN_PROGRAM, TOKEN_2022
from .providers import ProviderError


async def fetch_markets(providers, tokens: list[str]) -> dict[str, Market]:
    if not tokens:
        return {}
    data = await providers.request("dex", "GET", "https://api.dexscreener.com/tokens/v1/solana/" + ",".join(tokens[:30]))
    now = time.time()
    result: dict[str, Market] = {}
    for p in data:
        token = p.get("baseToken", {}).get("address")
        if p.get("chainId") != "solana" or token not in tokens or not p.get("priceUsd"):
            continue
        liquidity = float(p.get("liquidity", {}).get("usd", 0) or 0)
        if token in result and result[token].liquidity_usd >= liquidity:
            continue
        result[token] = Market(token=token, symbol=p["baseToken"].get("symbol", token[:6]),
                               name=p["baseToken"].get("name", "Unknown"), pair=p["pairAddress"], dex=p.get("dexId", "unknown"),
                               price_usd=float(p["priceUsd"]), liquidity_usd=liquidity,
                               market_cap=p.get("marketCap"), fdv=p.get("fdv"),
                               volume_5m=p.get("volume", {}).get("m5"), received_at=now,
                               pair_created_at=(p["pairCreatedAt"] / 1000) if p.get("pairCreatedAt") else None)
    return result


async def inspect_mint(providers, token: str, vault_owners: set[str], distribution_timeout_s: float = 8) -> Security:
    result = await providers.rpc("getAccountInfo", [token, {"encoding": "jsonParsed", "commitment": "confirmed"}])
    value = result.get("value")
    if not value or value.get("owner") not in (TOKEN_PROGRAM, TOKEN_2022):
        raise ProviderError("Unsupported mint owner")
    parsed = value.get("data", {}).get("parsed", {})
    if parsed.get("type") != "mint":
        raise ProviderError("Not a parsed SPL mint")
    info = parsed["info"]
    extensions = [e.get("extension", "unknown") for e in info.get("extensions", [])]
    blockers = []
    warnings = ["Kein vollständiger Rug-/Honeypot-Audit", "Holder-Anzahl und Funding-Cluster nicht indexiert"]
    if info.get("mintAuthority"):
        blockers.append("Aktive Mint Authority")
    if info.get("freezeAuthority"):
        blockers.append("Aktive Freeze Authority")
    unreviewed = set(extensions) - {"metadataPointer", "tokenMetadata"}
    if unreviewed:
        blockers.append("Nicht freigegebene Token-2022-Erweiterungen: " + ", ".join(sorted(unreviewed)))
    if not info.get("isInitialized", True):
        blockers.append("Mint nicht initialisiert")
    mint_checked_at = time.time()
    supply = int(info["supply"])
    if supply <= 0:
        raise ProviderError("Zero token supply")
    owners: dict[str, int] = defaultdict(int)
    accounts = []
    distribution_complete = False
    try:
        async with asyncio.timeout(distribution_timeout_s):
            largest = await providers.rpc("getTokenLargestAccounts", [token, {"commitment": "confirmed"}])
            accounts = largest.get("value", [])
            if accounts:
                resolved = await providers.rpc("getMultipleAccounts", [[x["address"] for x in accounts],
                                                                        {"encoding": "jsonParsed", "commitment": "confirmed"}])
                for a, meta in zip(accounts, resolved.get("value", []), strict=True):
                    if meta is None:
                        blockers.append("Unaufgelöstes großes Token-Konto")
                        continue
                    owner = meta.get("data", {}).get("parsed", {}).get("info", {}).get("owner")
                    if not owner:
                        blockers.append("Unaufgelöster Konto-Eigentümer")
                    elif owner not in vault_owners:
                        owners[owner] += int(a["amount"])
                distribution_complete = not any("Unaufgelöst" in b for b in blockers)
            else:
                blockers.append("Keine Distribution-Daten")
    except (TimeoutError, ProviderError):
        blockers.append("Distribution-Daten fehlen: RPC-Timeout oder Provider-Fehler")
    warnings.append("Konzentration beruht auf Top-20-Konten; weitere Konten eines Eigentümers können fehlen")
    return Security(token=token, checked_at=mint_checked_at, received_at=time.time(), decimals=int(info["decimals"]), supply_raw=supply,
                    mint_authority=info.get("mintAuthority"), freeze_authority=info.get("freezeAuthority"),
                    token_program=value["owner"], extensions=extensions,
                    largest_observed_owner_share=max(owners.values(), default=0) / supply if distribution_complete else None,
                    sampled_accounts=len(accounts), excluded_vault_owners=sorted(vault_owners), blockers=blockers, warnings=warnings)
