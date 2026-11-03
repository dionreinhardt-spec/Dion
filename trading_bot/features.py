from __future__ import annotations

import numpy as np
import pandas as pd


FEATURE_COLUMNS = [
    "ret_1d",
    "ret_7d",
    "ret_30d",
    "trend_20",
    "trend_50",
    "macd_norm",
    "rsi_14",
    "volatility_20",
    "bollinger_z",
    "volume_z_20",
    "relative_strength_7d",
    "relative_strength_30d",
    "market_breadth_7d",
    "log_market_cap",
    "turnover",
]


def _rsi(series: pd.Series, window: int = 14) -> pd.Series:
    delta = series.diff()
    gains = delta.clip(lower=0).rolling(window).mean()
    losses = -delta.clip(upper=0).rolling(window).mean()
    rs = gains / losses.replace(0, np.nan)
    return 100 - (100 / (1 + rs))


def _safe_zscore(series: pd.Series, window: int) -> pd.Series:
    mean = series.rolling(window).mean()
    std = series.rolling(window).std(ddof=0).replace(0, np.nan)
    return (series - mean) / std


def build_feature_panel(
    histories: dict[str, pd.DataFrame],
    horizon_days: int,
    round_trip_cost_fraction: float,
    benchmark_id: str = "bitcoin",
) -> pd.DataFrame:
    if benchmark_id not in histories:
        benchmark_id = max(histories, key=lambda key: float(histories[key]["market_cap"].iloc[-1]))

    benchmark = histories[benchmark_id][["date", "close"]].copy().sort_values("date")
    benchmark["bench_ret_7d"] = benchmark["close"].pct_change(7)
    benchmark["bench_ret_30d"] = benchmark["close"].pct_change(30)
    benchmark = benchmark[["date", "bench_ret_7d", "bench_ret_30d"]]

    panels: list[pd.DataFrame] = []
    for asset_id, original in histories.items():
        frame = original.copy().sort_values("date").drop_duplicates("date", keep="last")
        frame["ret_1d"] = frame["close"].pct_change(1)
        frame["ret_7d"] = frame["close"].pct_change(7)
        frame["ret_30d"] = frame["close"].pct_change(30)
        frame["trend_20"] = frame["close"] / frame["close"].rolling(20).mean() - 1
        frame["trend_50"] = frame["close"] / frame["close"].rolling(50).mean() - 1
        frame["sma_20"] = frame["close"].rolling(20).mean()
        frame["sma_50"] = frame["close"].rolling(50).mean()
        rolling_std_20 = frame["close"].rolling(20).std(ddof=0)
        frame["bollinger_upper"] = frame["sma_20"] + 2 * rolling_std_20
        frame["bollinger_lower"] = frame["sma_20"] - 2 * rolling_std_20
        ema_12 = frame["close"].ewm(span=12, adjust=False).mean()
        ema_26 = frame["close"].ewm(span=26, adjust=False).mean()
        frame["macd_norm"] = (ema_12 - ema_26) / frame["close"]
        frame["rsi_14"] = _rsi(frame["close"], 14) / 100
        frame["volatility_20"] = frame["ret_1d"].rolling(20).std(ddof=0) * np.sqrt(365)
        frame["bollinger_z"] = _safe_zscore(frame["close"], 20)
        frame["volume_z_20"] = _safe_zscore(np.log1p(frame["volume"]), 20)
        frame["log_market_cap"] = np.log(frame["market_cap"].clip(lower=1))
        frame["turnover"] = frame["volume"] / frame["market_cap"].replace(0, np.nan)
        frame = frame.merge(benchmark, on="date", how="left")
        frame["relative_strength_7d"] = frame["ret_7d"] - frame["bench_ret_7d"]
        frame["relative_strength_30d"] = frame["ret_30d"] - frame["bench_ret_30d"]
        frame["forward_return"] = frame["close"].shift(-horizon_days) / frame["close"] - 1
        frame["target_up"] = (frame["forward_return"] > round_trip_cost_fraction).astype(float)
        frame.loc[frame["forward_return"].isna(), "target_up"] = np.nan
        frame["asset_id"] = asset_id
        panels.append(frame)

    panel = pd.concat(panels, ignore_index=True).sort_values(["date", "asset_id"])
    breadth = panel.groupby("date")["ret_7d"].apply(lambda values: float((values > 0).mean())).rename("market_breadth_7d")
    panel = panel.merge(breadth, on="date", how="left")
    return panel.reset_index(drop=True)


def latest_feature_rows(panel: pd.DataFrame) -> pd.DataFrame:
    complete = panel.dropna(subset=FEATURE_COLUMNS)
    if complete.empty:
        return complete
    idx = complete.groupby("asset_id")["date"].idxmax()
    return complete.loc[idx].sort_values("market_cap", ascending=False).reset_index(drop=True)
