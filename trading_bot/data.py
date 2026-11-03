from __future__ import annotations

import json
import math
import os
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

import numpy as np
import pandas as pd

from .config import MarketConfig


class MarketDataError(RuntimeError):
    pass


@dataclass(slots=True)
class UniverseAsset:
    coin_id: str
    symbol: str
    name: str
    current_price: float
    market_cap: float
    total_volume: float
    market_cap_rank: int


class CoinGeckoClient:
    """Small read-only CoinGecko client with cache, retries and rate pacing."""

    def __init__(self, config: MarketConfig, cache_dir: str | Path = ".cache/coin_data") -> None:
        self.config = config
        self.base_url = "https://api.coingecko.com/api/v3"
        self.cache_dir = Path(cache_dir)
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self.api_key = os.getenv("COINGECKO_API_KEY", "").strip()
        self._last_request_at = 0.0

    def _require_api_key(self) -> None:
        if not self.api_key:
            raise MarketDataError(
                "Real CoinGecko scans require COINGECKO_API_KEY. "
                "Create a Demo API key or run with --demo for synthetic data."
            )

    def _cache_path(self, key: str) -> Path:
        safe = "".join(c if c.isalnum() or c in "-_" else "_" for c in key)
        return self.cache_dir / f"{safe}.json"

    def _get_json(self, path: str, params: dict[str, object], cache_key: str) -> object:
        self._require_api_key()
        cache_path = self._cache_path(cache_key)
        if cache_path.exists() and time.time() - cache_path.stat().st_mtime <= self.config.cache_ttl_seconds:
            return json.loads(cache_path.read_text(encoding="utf-8"))

        query = urllib.parse.urlencode(params)
        url = f"{self.base_url}{path}?{query}"
        headers = {"Accept": "application/json", "User-Agent": "ai-paper-trader/0.1"}
        headers["x-cg-demo-api-key"] = self.api_key

        last_error: Exception | None = None
        for attempt in range(4):
            wait = self.config.request_delay_seconds - (time.monotonic() - self._last_request_at)
            if wait > 0:
                time.sleep(wait)
            request = urllib.request.Request(url, headers=headers)
            try:
                with urllib.request.urlopen(request, timeout=30) as response:
                    payload = json.load(response)
                self._last_request_at = time.monotonic()
                cache_path.write_text(json.dumps(payload), encoding="utf-8")
                return payload
            except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
                last_error = exc
                self._last_request_at = time.monotonic()
                time.sleep(min(2**attempt, 8))
        raise MarketDataError(f"CoinGecko request failed after retries: {last_error}")

    def get_universe(self) -> list[UniverseAsset]:
        raw = self._get_json(
            "/coins/markets",
            {
                "vs_currency": self.config.vs_currency,
                "order": "market_cap_desc",
                "per_page": min(self.config.universe_size, 250),
                "page": 1,
                "sparkline": "false",
            },
            f"markets_{self.config.vs_currency}_{self.config.universe_size}",
        )
        assets: list[UniverseAsset] = []
        for row in raw:  # type: ignore[union-attr]
            market_cap = float(row.get("market_cap") or 0)
            volume = float(row.get("total_volume") or 0)
            price = float(row.get("current_price") or 0)
            if market_cap < self.config.min_market_cap or volume < self.config.min_daily_volume or price <= 0:
                continue
            assets.append(
                UniverseAsset(
                    coin_id=str(row["id"]),
                    symbol=str(row["symbol"]).upper(),
                    name=str(row["name"]),
                    current_price=price,
                    market_cap=market_cap,
                    total_volume=volume,
                    market_cap_rank=int(row.get("market_cap_rank") or 999_999),
                )
            )
        if len(assets) < 5:
            raise MarketDataError("Fewer than five liquid assets passed the configured universe filters")
        return assets

    def get_history(self, asset: UniverseAsset) -> pd.DataFrame:
        raw = self._get_json(
            f"/coins/{urllib.parse.quote(asset.coin_id)}/market_chart",
            {
                "vs_currency": self.config.vs_currency,
                "days": self.config.lookback_days,
                "interval": "daily",
            },
            f"history_{asset.coin_id}_{self.config.vs_currency}_{self.config.lookback_days}",
        )
        frames: list[pd.DataFrame] = []
        for field, output in [("prices", "close"), ("total_volumes", "volume"), ("market_caps", "market_cap")]:
            values = raw.get(field, [])  # type: ignore[union-attr]
            frame = pd.DataFrame(values, columns=["timestamp_ms", output])
            frame["date"] = pd.to_datetime(frame["timestamp_ms"], unit="ms", utc=True).dt.floor("D")
            frames.append(frame[["date", output]].groupby("date", as_index=False).last())
        history = frames[0]
        for frame in frames[1:]:
            history = history.merge(frame, on="date", how="outer")
        history = history.sort_values("date").drop_duplicates("date", keep="last")
        history[["close", "volume", "market_cap"]] = history[["close", "volume", "market_cap"]].ffill()
        history["asset_id"] = asset.coin_id
        history["symbol"] = asset.symbol
        return history.dropna(subset=["close"]).reset_index(drop=True)

    def load_histories(self, assets: Iterable[UniverseAsset]) -> dict[str, pd.DataFrame]:
        histories: dict[str, pd.DataFrame] = {}
        errors: list[str] = []
        for asset in assets:
            try:
                history = self.get_history(asset)
                if len(history) >= self.config.lookback_days * 0.55:
                    histories[asset.coin_id] = history
                else:
                    errors.append(f"{asset.symbol}: insufficient history ({len(history)} rows)")
            except MarketDataError as exc:
                errors.append(f"{asset.symbol}: {exc}")
        if len(histories) < 5:
            detail = "; ".join(errors[:5])
            raise MarketDataError(f"Insufficient usable histories. {detail}")
        return histories


def generate_demo_market(days: int = 420, seed: int = 7) -> tuple[list[UniverseAsset], dict[str, pd.DataFrame]]:
    """Create deterministic regime-switching data for safe offline testing.

    It is deliberately synthetic and must never be presented as market evidence.
    """

    rng = np.random.default_rng(seed)
    dates = pd.date_range(end=pd.Timestamp.now(tz="UTC").floor("D"), periods=days, freq="D")
    definitions = [
        ("bitcoin", "BTC", "Bitcoin", 75_000, 1_500_000_000_000, 28_000_000_000, 1.0),
        ("ethereum", "ETH", "Ethereum", 2_400, 290_000_000_000, 16_000_000_000, 1.15),
        ("solana", "SOL", "Solana", 105, 58_000_000_000, 3_000_000_000, 1.45),
        ("chainlink", "LINK", "Chainlink", 12, 8_000_000_000, 400_000_000, 1.25),
        ("aave", "AAVE", "Aave", 150, 2_400_000_000, 250_000_000, 1.4),
        ("render-token", "RENDER", "Render", 4.2, 2_100_000_000, 150_000_000, 1.7),
        ("demo-meme", "MEME", "Synthetic Meme", 0.02, 180_000_000, 18_000_000, 2.8),
        ("demo-small", "SMALL", "Synthetic Small Cap", 0.40, 90_000_000, 5_000_000, 2.2),
    ]
    regime = np.zeros(days)
    regime[: days // 3] = 0.0008
    regime[days // 3 : 2 * days // 3] = -0.0009
    regime[2 * days // 3 :] = 0.0004
    benchmark_shock = rng.normal(0, 0.018, days) + regime
    assets: list[UniverseAsset] = []
    histories: dict[str, pd.DataFrame] = {}
    for rank, (coin_id, symbol, name, last_price, market_cap, volume, beta) in enumerate(definitions, start=1):
        idio = rng.normal(0, 0.012 * beta, days)
        momentum = pd.Series(benchmark_shock).rolling(7, min_periods=1).mean().shift(1).fillna(0).to_numpy()
        returns = beta * benchmark_shock + 0.22 * momentum + idio
        raw_price = 100 * np.exp(np.cumsum(returns))
        price = raw_price * (last_price / raw_price[-1])
        volume_noise = np.exp(rng.normal(0, 0.35, days))
        volumes = volume * volume_noise * (1 + np.minimum(np.abs(returns) * 8, 2))
        caps = market_cap * price / price[-1]
        history = pd.DataFrame(
            {
                "date": dates,
                "close": price,
                "volume": volumes,
                "market_cap": caps,
                "asset_id": coin_id,
                "symbol": symbol,
            }
        )
        assets.append(UniverseAsset(coin_id, symbol, name, float(price[-1]), market_cap, volume, rank))
        histories[coin_id] = history
    return assets, histories
