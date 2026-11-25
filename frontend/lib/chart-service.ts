import { ChartError, chartIdentity, chartInterval, chooseChartPool, parseCandles, type ChartPool, type CoinChartData } from "./coin-chart.ts";
const ROOT = "https://api.geckoterminal.com/api/v2";
type Deps = { fetcher?: typeof fetch; now?: () => number };
type Cached<T> = { value: T; expires: number; created: number };
export function createChartService({ fetcher = fetch, now = Date.now }: Deps = {}) {
  const pools = new Map<string, Cached<ChartPool>>(), candles = new Map<string, Cached<CoinChartData>>();
  const negativePools = new Map<string, number>();
  const poolRequests = new Map<string, Promise<ChartPool>>(), requests = new Map<string, Promise<CoinChartData>>();
  let providerCalls: number[] = [], blockedUntil = 0;
  function put<T>(map: Map<string, Cached<T>>, key: string, value: T, ttl: number, maximum: number) {
    map.delete(key); map.set(key, { value, expires: now() + ttl, created: now() });
    while (map.size > maximum) map.delete(map.keys().next().value!);
  }
  async function provider(path: string) {
    providerCalls = providerCalls.filter(time => time > now() - 60_000);
    if (blockedUntil > now()) throw new ChartError(429, "Die Chart-Datenquelle hat ihr Abruflimit erreicht.", Math.max(1, Math.ceil((blockedUntil - now()) / 1000)));
    if (providerCalls.length >= 8) throw new ChartError(429, "Das kostenlose Chart-Datenlimit ist erreicht. Bitte kurz warten.", Math.max(1, Math.ceil((providerCalls[0] + 60_000 - now()) / 1000)));
    providerCalls.push(now());
    let response: Response;
    try { response = await fetcher(ROOT + path, { headers: { accept: "application/json" }, cache: "no-store", signal: AbortSignal.timeout(8000) }); }
    catch { throw new ChartError(503, "Die Chart-Datenquelle ist momentan nicht erreichbar."); }
    if (response.status === 429) {
      const header = response.headers.get("retry-after");
      const delay = header && Number.isFinite(Number(header)) ? Number(header) : header && Number.isFinite(Date.parse(header)) ? (Date.parse(header) - now()) / 1000 : 60;
      const seconds = Math.max(1, Math.min(300, Math.ceil(delay)));
      blockedUntil = now() + seconds * 1000;
      throw new ChartError(429, "Die Chart-Datenquelle bittet um eine Abrufpause.", seconds);
    }
    if (!response.ok) throw new ChartError(response.status === 404 ? 404 : 503, response.status === 404 ? "Für diesen Pool sind noch keine Chart-Daten verfügbar." : "Die Chart-Datenquelle meldet eine vorübergehende Störung.");
    try { const text = await response.text(); if (text.length > 1_000_000) throw new Error(); return JSON.parse(text) as unknown; }
    catch { throw new ChartError(502, "Die Chart-Datenquelle hat keine gültigen JSON-Daten geliefert."); }
  }
  async function resolvePool(chain: string, token: string) {
    const key = `${chain}:${token}`, cached = pools.get(key);
    if (cached && cached.expires > now()) return cached.value;
    if ((negativePools.get(key) ?? 0) > now()) throw new ChartError(404, "Für diesen Contract ist noch kein passender öffentlicher Pool-Chart verfügbar.");
    const running = poolRequests.get(key); if (running) return running;
    const work = (async () => {
      try {
        const body = await provider(`/networks/${chain}/tokens/${encodeURIComponent(token)}/pools?page=1`);
        const pool = chooseChartPool(body, chain, token); put(pools, key, pool, 300_000, 128); return pool;
      } catch (error) {
        if (error instanceof ChartError && error.status === 404) { negativePools.set(key, now() + 60_000); while (negativePools.size > 128) negativePools.delete(negativePools.keys().next().value!); }
        throw error;
      } finally { poolRequests.delete(key); }
    })();
    poolRequests.set(key, work); return work;
  }
  async function get(chainInput: string, token: string, intervalInput: string): Promise<CoinChartData> {
    const { chain } = chartIdentity(chainInput, token), interval = chartInterval(intervalInput);
    const key = `${chain}:${token}:${interval.value}`, cached = candles.get(key);
    if (cached && cached.expires > now()) return cached.value;
    const running = requests.get(key); if (running) return running;
    const work = (async () => {
      try {
        const pool = await resolvePool(chain, token);
        const query = new URLSearchParams({ aggregate: String(interval.aggregate), limit: "200", currency: "usd", token: pool.tokenSide, include_empty_intervals: "false" });
        const body = await provider(`/networks/${chain}/pools/${encodeURIComponent(pool.address)}/ohlcv/${interval.timeframe}?${query}`);
        const data: CoinChartData = { chain, token, interval: interval.value, pool, provider: "GeckoTerminal", candles: parseCandles(body, interval.value, now() / 1000), fetchedAt: now() / 1000, stale: false, warning: null };
        put(candles, key, data, 60_000, 256); return data;
      } catch (error) {
        if (cached && now() - cached.created <= 900_000) return { ...cached.value, stale: true, warning: error instanceof ChartError ? error.message : "Chart-Update fehlgeschlagen." };
        throw error;
      } finally { requests.delete(key); }
    })();
    requests.set(key, work); return work;
  }
  return { get };
}
export const chartService = createChartService();
