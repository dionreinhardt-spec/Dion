import type { Flow, Token } from "../app/types";

export type ScannerPreset = "all" | "trending" | "inflow" | "entries";
export type ScannerSort = "buyers" | "inflow" | "volume" | "liquidity" | "score";
export type ScannerFilterState = {
  query: string;
  preset: ScannerPreset;
  windowKey: string;
  minBuyers: number;
  minLiquidity: number;
  status: string;
  sort: ScannerSort;
  hideSuspicious: boolean;
};
export type ScannerContext = { fresh: boolean; connected: boolean; serverTime: number | null };

export const DEFAULT_SCANNER_FILTERS: ScannerFilterState = {
  query: "", preset: "all", windowKey: "60", minBuyers: 100,
  minLiquidity: 0, status: "all", sort: "buyers", hideSuspicious: true,
};
export const FLOW_WINDOWS = [
  { value: "5", label: "5 Sekunden", short: "5s" },
  { value: "15", label: "15 Sekunden", short: "15s" },
  { value: "30", label: "30 Sekunden", short: "30s" },
  { value: "60", label: "1 Minute", short: "1m" },
  { value: "300", label: "5 Minuten", short: "5m" },
  { value: "900", label: "15 Minuten", short: "15m" },
  { value: "3600", label: "1 Stunde", short: "1h" },
  { value: "86400", label: "24 Stunden", short: "24h" },
];
export const windowLabel = (key: string) => FLOW_WINDOWS.find(w => w.value === key)?.short ?? key + "s";
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const count = (value: unknown) => finite(value) && Number.isSafeInteger(value) && value >= 0 ? value : null;

export function suspiciousFlow(flow: Flow | undefined): boolean {
  return !!flow && ((finite(flow.roundtrip_volume_share) && flow.roundtrip_volume_share > 0.65) ||
    (finite(flow.max_wallet_volume_share) && flow.max_wallet_volume_share > 0.8));
}

/** Activity classification only; never changes token.status or plan.allowed. */
export function hasRecentActivity(token: Token, context: ScannerContext): boolean {
  if (!context.fresh || !context.connected || !finite(context.serverTime)) return false;
  if (!finite(token.last_event_at) || !finite(token.evaluated_at)) return false;
  const tradeAge = context.serverTime - token.last_event_at;
  const evaluationAge = context.serverTime - token.evaluated_at;
  return tradeAge >= -3 && tradeAge <= 15 && evaluationAge >= -3 && evaluationAge <= 5;
}

function sortValue(token: Token, filters: ScannerFilterState): number | null {
  const flow = token.windows?.[filters.windowKey];
  switch (filters.sort) {
    case "buyers": return count(flow?.unique_buyers);
    case "inflow": return finite(flow?.net_flow_usd) ? flow.net_flow_usd : null;
    case "volume": return finite(token.market?.volume_5m) ? token.market.volume_5m : null;
    case "liquidity": return finite(token.market?.liquidity_usd) ? token.market.liquidity_usd : null;
    case "score": return finite(token.score) ? token.score : null;
  }
}

export function selectScannerTokens(tokens: readonly Token[], filters: ScannerFilterState, context: ScannerContext): Token[] {
  const query = filters.query.trim().toLowerCase();
  const minBuyers = finite(filters.minBuyers) ? Math.max(1, Math.floor(filters.minBuyers)) : 100;
  const liquidity = finite(filters.minLiquidity) ? Math.max(0, filters.minLiquidity) : 0;
  const matches = tokens.filter(token => {
    if (query && !`${token.symbol} ${token.name} ${token.token}`.toLowerCase().includes(query)) return false;
    if (filters.status !== "all" && token.status !== filters.status) return false;
    if (liquidity > 0 && (!finite(token.market?.liquidity_usd) || token.market.liquidity_usd < liquidity)) return false;
    if (filters.preset === "all") return true;
    if (!hasRecentActivity(token, context)) return false;
    if (filters.preset === "entries") return token.status === "ENTRY_CANDIDATE";
    const flow = token.windows?.[filters.windowKey];
    if (!flow || (filters.hideSuspicious && suspiciousFlow(flow))) return false;
    if (filters.preset === "trending") {
      const buyers = count(flow.unique_buyers);
      return buyers !== null && buyers >= minBuyers;
    }
    return finite(flow.net_flow_usd) && flow.net_flow_usd > 0 && finite(flow.priced_fraction) && flow.priced_fraction >= 0.8;
  });
  return matches.sort((a, b) => {
    const left = sortValue(a, filters), right = sortValue(b, filters);
    if (left === null && right !== null) return 1;
    if (right === null && left !== null) return -1;
    if (left !== null && right !== null && left !== right) return right - left;
    return a.token.localeCompare(b.token);
  });
}
