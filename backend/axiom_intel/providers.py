"""Rate-limited provider IO. Never include credential-bearing URLs in logs."""
import asyncio
import time
import random
from collections import Counter
from email.utils import parsedate_to_datetime
import httpx


class ProviderError(RuntimeError):
    pass


class RateGate:
    def __init__(self, rps: float):
        self.interval = 1 / rps
        self.lock = asyncio.Lock()
        self.next_at = 0.0

    async def wait(self):
        async with self.lock:
            now = time.monotonic()
            await asyncio.sleep(max(0, self.next_at - now))
            self.next_at = time.monotonic() + self.interval


def retry_delay(value: str | None, attempt: int) -> float:
    if value:
        try:
            return max(0, float(value))
        except ValueError:
            try:
                return max(0, parsedate_to_datetime(value).timestamp() - time.time())
            except (ValueError, TypeError):
                pass
    return min(30, 2**attempt) + random.random()


class Providers:
    def __init__(self, settings):
        self.settings = settings
        self.client = httpx.AsyncClient(timeout=15, follow_redirects=False)
        self.gates = {"rpc": RateGate(settings.rpc_rps), "dex": RateGate(2), "jupiter": RateGate(.45), "evm": RateGate(2)}
        self.slots = asyncio.Semaphore(settings.rpc_concurrency)
        self.calls = Counter()
        self.errors = Counter()
        self.last_success: dict[str, float] = {}
        self.price_cache: dict[str, tuple[float, float]] = {}
        self.serial = 0

    async def request(self, provider: str, method: str, url: str, **kwargs):
        for attempt in range(4):
            await self.gates.get(provider, self.gates["dex"]).wait()
            self.calls[provider] += 1
            try:
                async with self.slots:
                    r = await self.client.request(method, url, **kwargs)
                if r.status_code == 429 or r.status_code >= 500:
                    self.errors[provider] += 1
                    # Long Retry-After values remain respected without a blocking sleep.
                    await asyncio.sleep(retry_delay(r.headers.get("retry-after"), attempt))
                    continue
                r.raise_for_status()
                data = r.json()
                self.last_success[provider] = time.time()
                return data
            except (httpx.HTTPError, ValueError):
                self.errors[provider] += 1
                if attempt == 3:
                    break
                await asyncio.sleep(min(20, 2**attempt) + random.random())
        raise ProviderError(f"{provider}: request failed; details redacted")

    async def rpc(self, method: str, params: list):
        self.serial += 1
        data = await self.request("rpc", "POST", self.settings.solana_rpc_http.get_secret_value(),
                                  json={"jsonrpc": "2.0", "id": self.serial, "method": method, "params": params})
        if data.get("error"):
            self.errors["rpc"] += 1
            raise ProviderError(f"rpc: {method} rejected (code {data['error'].get('code', 'unknown')})")
        return data.get("result")

    async def evm(self, method: str, params: list):
        self.serial += 1
        data = await self.request("evm", "POST", self.settings.robinhood_rpc_http.get_secret_value(),
                                  json={"jsonrpc": "2.0", "id": self.serial, "method": method, "params": params})
        if data.get("error"):
            raise ProviderError(f"evm: {method} rejected")
        return data.get("result")

    async def prices(self, mints: list[str]):
        data = await self.request("jupiter", "GET", "https://api.jup.ag/price/v3", params={"ids": ",".join(mints)})
        now = time.time()
        for mint, p in data.items():
            price = p.get("usdPrice") if isinstance(p, dict) else None
            if price and float(price) > 0:
                # Jupiter supplies blockId, not a wall-clock quote timestamp.
                self.price_cache[mint] = (float(price), now)

    def quote(self, mint: str, now: float) -> tuple[float | None, float | None]:
        p, at = self.price_cache.get(mint, (None, None))
        return (p, at) if at and at <= now and now - at <= self.settings.max_price_age_s else (None, None)

    async def close(self):
        await self.client.aclose()
