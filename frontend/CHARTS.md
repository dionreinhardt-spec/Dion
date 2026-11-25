# Contract-specific TradingView charts

Each scanner coin has a Chart button. Desktop rows, iPhone cards, the selected-token panel and the analyst open one large chart dialog. TradingView Lightweight Charts 5.2.1 is loaded only when needed; it is the open-source chart library, not a logged-in TradingView terminal or the licensed Advanced Charts product. No order execution is added.

The chart includes candlesticks, USD volume, crosshair, pan/zoom, fit-to-view, and 1m/5m/15m/1h/1d intervals. The chart and receipt times use Europe/Berlin. The complete contract address stays visible in the dialog. Only one chart is mounted at once.

## Actual market data

The frontend's Node route `/api/charts/solana/CONTRACT?interval=1m` resolves GeckoTerminal pools by contract address. It requires an exact base-token or quote-token relationship and chooses the highest disclosed liquidity among matching pools. It never searches or substitutes a ticker. Quote-token pools request quote-side prices explicitly. OHLCV data is USD-denominated, sorted, deduplicated and validated; no missing candle or volume is invented.

The new dynamic route is served by the existing frontend service before its general backend API rewrite, which is explicitly a fallback rewrite. The production manifest check verifies this ordering. It does not modify or restart the scanner backend. This version supports Solana chart data only. A new or still-unindexed token may have no public pool/history yet. The dialog then explains that condition instead of showing an unrelated chart.

## Operation and limits

No additional paid data service or API key is enabled. Public endpoints: `https://api.geckoterminal.com/api/v2/networks/solana/tokens/{address}/pools` and `/networks/solana/pools/{pool}/ohlcv/{timeframe}`. The public provider's current documentation advertises 10 requests/minute. The service allows at most eight per minute across all its requests, honours 429 Retry-After, merges concurrent requests, caches pool identity for five minutes and candles for one minute, and caps retained cache entries. Limits are per frontend process; this deployment has one replica. Horizontal scaling requires a shared budget/cache.

Only the open, visible chart checks for updates, every 60 seconds. Interval/coin changes cancel and ignore old responses; background/offline sessions pause. On provider failure, cached data up to 15 minutes old is explicitly marked stale with its original receipt timestamp. Older server cache is not silently served. Previously drawn browser history can remain visible with a warning. Provider uptime, coverage and instantaneous quotes are not guaranteed.

## Verification

47 frontend tests cover the existing filters/connection safety plus 14 chart cases: actual address validation, exact token identity, quote orientation, liquidity selection, OHLCV validation, sorting/deduplication, singleflight/cache, negative caching, rate limits, outages and rejection of responses for another contract or interval. TypeScript, production build, PWA assets, deployed API routing and a real contract-to-pool-to-OHLCV request are checked before reporting publication.

The provider integration was verified using a real Solana token and its actual pool. Synthetic fixtures are used only inside automated tests, never for displayed charts. Physical-iPhone testing is not claimed.

## Primary references

- https://tradingview.github.io/lightweight-charts/
- https://github.com/tradingview/lightweight-charts/tree/v5.2.1
- https://www.geckoterminal.com/dex-api
- https://docs.coingecko.com/demo/reference/top-pools-contract-address
- https://docs.coingecko.com/demo/reference/pool-ohlcv-contract-address

The required TradingView logo/link remains enabled; the exact library notice is in `THIRD_PARTY_NOTICES.md`. Market-data and chart-library attribution are visible in the dialog.
