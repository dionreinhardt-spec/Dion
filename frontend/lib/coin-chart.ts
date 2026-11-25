export const CHART_INTERVALS = [
  { value: "1m", label: "1m", timeframe: "minute", aggregate: 1, seconds: 60 },
  { value: "5m", label: "5m", timeframe: "minute", aggregate: 5, seconds: 300 },
  { value: "15m", label: "15m", timeframe: "minute", aggregate: 15, seconds: 900 },
  { value: "1h", label: "1h", timeframe: "hour", aggregate: 1, seconds: 3600 },
  { value: "1d", label: "1T", timeframe: "day", aggregate: 1, seconds: 86400 },
] as const;
export type ChartInterval = typeof CHART_INTERVALS[number]["value"];
export type ChartSelection = { token: string; chain: string; symbol: string };
export type Candle = { time: number; open: number; high: number; low: number; close: number; volume: number };
export type ChartPool = { address: string; name: string; dex: string; tokenSide: "base" | "quote"; baseToken: string; quoteToken: string; liquidityUsd: number | null; url: string };
export type CoinChartData = { chain: string; token: string; interval: ChartInterval; candles: Candle[]; pool: ChartPool; provider: "GeckoTerminal"; fetchedAt: number; stale: boolean; warning: string | null };
export class ChartError extends Error {
  status: number;
  retryAfter: number;
  constructor(status: number, message: string, retryAfter = 60) { super(message); this.name = "ChartError"; this.status = status; this.retryAfter = retryAfter; }
}
const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function isSolanaAddress(value: string): boolean {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value)) return false;
  let number = 0n;
  for (const char of value) number = number * 58n + BigInt(ALPHABET.indexOf(char));
  let bytes = 0;
  while (number > 0n) { bytes++; number >>= 8n; }
  return bytes + (value.match(/^1+/)?.[0].length ?? 0) === 32;
}
export function chartIdentity(chain: string, token: string) {
  if (chain.toLowerCase() !== "solana") throw new ChartError(422, "Für diese Chain ist die Chart-Datenquelle noch nicht angebunden.");
  if (!isSolanaAddress(token)) throw new ChartError(400, "Ungültige Solana-Contract-Adresse.");
  return { chain: "solana", token };
}
export function chartInterval(value: string) {
  const interval = CHART_INTERVALS.find(item => item.value === value);
  if (!interval) throw new ChartError(400, "Dieses Chart-Zeitfenster wird nicht unterstützt.");
  return interval;
}
const obj = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const at = (value: unknown, ...keys: string[]): unknown => keys.reduce<unknown>((current, key) => obj(current)[key], value);
const numeric = (value: unknown): number | null => {
  if (typeof value !== "number" && (typeof value !== "string" || !value.trim())) return null;
  const n = Number(value); return Number.isFinite(n) ? n : null;
};
export function chooseChartPool(body: unknown, chain: string, token: string): ChartPool {
  const identity = chartIdentity(chain, token);
  const rows = at(body, "data");
  if (!Array.isArray(rows)) throw new ChartError(502, "Die Pool-Datenquelle hat ein unbekanntes Datenformat geliefert.");
  const pools: ChartPool[] = [];
  for (const row of rows) {
    const address = at(row, "attributes", "address");
    if (typeof address !== "string" || !isSolanaAddress(address) || at(row, "id") !== `${identity.chain}_${address}`) continue;
    const baseId = at(row, "relationships", "base_token", "data", "id");
    const quoteId = at(row, "relationships", "quote_token", "data", "id");
    const prefix = `${identity.chain}_`;
    if (typeof baseId !== "string" || typeof quoteId !== "string" || !baseId.startsWith(prefix) || !quoteId.startsWith(prefix)) continue;
    const baseToken = baseId.slice(prefix.length), quoteToken = quoteId.slice(prefix.length);
    if (baseToken !== token && quoteToken !== token) continue;
    if (!isSolanaAddress(baseToken) || !isSolanaAddress(quoteToken)) continue;
    const liquidity = numeric(at(row, "attributes", "reserve_in_usd"));
    pools.push({ address, name: String(at(row, "attributes", "name") ?? "DEX-Pool"), dex: String(at(row, "relationships", "dex", "data", "id") ?? "DEX"),
      tokenSide: baseToken === token ? "base" : "quote", baseToken, quoteToken, liquidityUsd: liquidity !== null && liquidity >= 0 ? liquidity : null,
      url: `https://www.geckoterminal.com/${identity.chain}/pools/${encodeURIComponent(address)}` });
  }
  pools.sort((a, b) => (b.liquidityUsd ?? -1) - (a.liquidityUsd ?? -1) || a.address.localeCompare(b.address));
  if (!pools.length) throw new ChartError(404, "Für diesen Contract ist noch kein passender öffentlicher Pool-Chart verfügbar.");
  return pools[0];
}
export function parseCandles(body: unknown, interval: ChartInterval, nowSeconds: number): Candle[] {
  const rows = at(body, "data", "attributes", "ohlcv_list");
  if (!Array.isArray(rows)) throw new ChartError(502, "Die Kursdatenquelle hat ein unbekanntes Kerzenformat geliefert.");
  const step = chartInterval(interval).seconds;
  const bars = new Map<number, Candle>();
  for (const row of rows) {
    if (!Array.isArray(row) || row.length < 6) continue;
    const values = row.slice(0, 6).map(numeric);
    if (values.some(value => value === null)) continue;
    const [time, open, high, low, close, volume] = values as number[];
    if (!Number.isSafeInteger(time) || time <= 0 || time > nowSeconds + 5 || time % step !== 0 || open <= 0 || high <= 0 || low <= 0 || close <= 0 || volume < 0) continue;
    if (high < Math.max(open, close, low) || low > Math.min(open, close, high) || bars.has(time)) continue;
    bars.set(time, { time, open, high, low, close, volume });
  }
  if (rows.length && !bars.size) throw new ChartError(502, "Die gelieferten Kerzen sind unvollständig oder ungültig.");
  return [...bars.values()].sort((a, b) => a.time - b.time).slice(-200);
}
/** A late response for another token/timeframe must never be drawn. */
export function readChartData(value: unknown, selection: ChartSelection, interval: ChartInterval): CoinChartData {
  const identity = chartIdentity(selection.chain, selection.token);
  if (at(value, "chain") !== identity.chain || at(value, "token") !== identity.token || at(value, "interval") !== interval || at(value, "provider") !== "GeckoTerminal") {
    throw new ChartError(502, "Die Chart-Antwort gehört nicht zum ausgewählten Contract und Zeitfenster.");
  }
  const side = at(value, "pool", "tokenSide");
  const matched = side === "base" ? at(value, "pool", "baseToken") : side === "quote" ? at(value, "pool", "quoteToken") : null;
  if (matched !== identity.token || !Array.isArray(at(value, "candles")) || numeric(at(value, "fetchedAt")) === null) throw new ChartError(502, "Der Pool konnte nicht eindeutig dem Contract zugeordnet werden.");
  const rows = at(value, "candles") as unknown[];
  if (rows.some(row => ["time", "open", "high", "low", "close", "volume"].some(key => typeof at(row, key) !== "number" || !Number.isFinite(at(row, key))))) throw new ChartError(502, "Ungültige Chart-Daten.");
  return value as CoinChartData;
}
