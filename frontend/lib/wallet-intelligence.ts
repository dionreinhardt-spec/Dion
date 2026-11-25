import { isSolanaAddress } from "./coin-chart.ts";
import { isOffCurveAddress, type Address } from "@solana/addresses";

export const TOKEN_PROGRAMS = ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"] as const;
export const SYSTEM_PROGRAM = "11111111111111111111111111111111";
export const HOLDING_MAX_AGE = 600;
export const INSPECTION_MAX_AGE = 900;
export type WalletLabel = { wallet: string; name: string; handle: string; source: string; labelCheckedAt: string; note?: string };
export type Balance = { mint: string; raw: string; decimals: number };
export type WalletScan = { wallet: string; program: string; slot: number; checkedAt: number; balances: Record<string, Balance>; error: string | null };
export type KolHolding = { wallet: string; name: string; source: string; labelCheckedAt: string; raw: string; decimals: number; checkedAt: number; slot: number; valueUsd: number | null };
export type Holder = { wallet: string; raw: string; share: number; ordinaryWallet: boolean };
export type InsiderFlag = { id: "launch_holder" | "launch_funding" | "concentration"; label: string; detail: string; wallets: string[]; kind: "launch_link" | "distribution" };
export type Inspection = { token: string; checkedAt: number; slotMin: number; slotMax: number; top3Share: number | null; coverage: "launch_wallets" | "top20"; launchSigner: string | null; launchSignature: string | null; flags: InsiderFlag[]; holders: Holder[]; error: string | null };
export type IntelToken = { token: string; chain: "solana"; symbol: string; name: string; priceUsd: number | null; liquidityUsd: number | null; marketCap: number | null; marketAt: number | null; kol: KolHolding[]; inspection: Inspection | null };
export type WalletStatus = WalletLabel & { checkedAt: number | null; programsChecked: number; complete: boolean; nonzeroMints: number; error: string | null };
export type IntelligenceSnapshot = { serverTime: number; startedAt: number; sourceAt: number | null; wallets: WalletStatus[]; tokens: IntelToken[]; status: { running: boolean; rpcCallsLastMinute: number; rpcBudget: number; rpcErrors: number; lastRpcSuccess: number | null; sourceError: string | null; metadataError: string | null; holderMode: "launch_wallets" | "top20"; inspected: number; observedTokens: number; metadataPending: number }; scope: string };

export const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
export const field = (value: unknown, ...keys: string[]): unknown => keys.reduce<unknown>((v, key) => record(v)[key], value);
export const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const raw = (value: unknown): value is string => typeof value === "string" && /^\d{1,78}$/.test(value);
const decimals = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 30;
export function contextSlot(result: unknown): number {
  const slot = field(result, "context", "slot");
  if (!Number.isSafeInteger(slot) || Number(slot) <= 0) throw new Error("RPC-Kontext fehlt.");
  return Number(slot);
}

/** Every successful program snapshot replaces that program, including zero balances. */
export function parseWalletBalances(result: unknown, wallet: string, program: string): Record<string, Balance> {
  contextSlot(result);
  const rows = field(result, "value");
  if (!Array.isArray(rows) || rows.length > 30_000) throw new Error("Wallet-Antwort unvollständig oder zu groß.");
  const out: Record<string, Balance> = {};
  const seen = new Set<string>();
  for (const row of rows) {
    const address = field(row, "pubkey"), account = field(row, "account"), info = field(account, "data", "parsed", "info");
    const mint = field(info, "mint"), amount = field(info, "tokenAmount", "amount"), precision = field(info, "tokenAmount", "decimals");
    if (typeof address !== "string" || !isSolanaAddress(address) || seen.has(address)) throw new Error("Ungültige oder doppelte Token-Konten.");
    seen.add(address);
    if (field(account, "owner") !== program || field(info, "owner") !== wallet || field(account, "data", "parsed", "type") !== "account") throw new Error("Wallet-Zuordnung der Token-Konten ist nicht bestätigt.");
    if (typeof mint !== "string" || !isSolanaAddress(mint) || !raw(amount) || !decimals(precision)) throw new Error("Ungültiger Token-Bestand.");
    if (BigInt(amount) === 0n) continue;
    const previous = out[mint];
    if (previous && previous.decimals !== precision) throw new Error("Widersprüchliche Token-Dezimalstellen.");
    out[mint] = { mint, raw: (BigInt(previous?.raw ?? "0") + BigInt(amount)).toString(), decimals: precision };
  }
  return out;
}

export function freshAt(checkedAt: number, now: number, maxAge = HOLDING_MAX_AGE) { return finite(checkedAt) && now >= checkedAt - 5 && now - checkedAt <= maxAge; }
export function holdingValue(balance: Balance, price: number | null): number | null {
  if (!finite(price) || price <= 0) return null;
  const value = Number(balance.raw) / 10 ** balance.decimals * price;
  return Number.isFinite(value) ? value : null;
}
export function holdingsForToken(token: string, labels: readonly WalletLabel[], scans: readonly WalletScan[], now: number, price: number | null): KolHolding[] {
  const result: KolHolding[] = [];
  const seenWallets = new Set<string>();
  for (const label of labels) {
    if (seenWallets.has(label.wallet)) continue;
    seenWallets.add(label.wallet);
    // One wallet is one holder even if a bad provider repeats it across programs.
    const matches = scans.filter(s => s.wallet === label.wallet && freshAt(s.checkedAt, now) && s.balances[token]);
    if (!matches.length) continue;
    if (matches.length > 1 && new Set(matches.map(s => s.program)).size > 1) continue;
    const scan = matches.sort((a, b) => b.checkedAt - a.checkedAt)[0], balance = scan.balances[token];
    result.push({ wallet: label.wallet, name: label.name, source: label.source, labelCheckedAt: label.labelCheckedAt, raw: balance.raw, decimals: balance.decimals, checkedAt: scan.checkedAt, slot: scan.slot, valueUsd: holdingValue(balance, price) });
  }
  return result;
}
export function activeHoldings(token: IntelToken | undefined, now: number, includeUnpriced = false): KolHolding[] {
  return (token?.kol ?? []).filter(h => freshAt(h.checkedAt, now) && (h.valueUsd !== null ? h.valueUsd >= 25 : includeUnpriced));
}
export function currentFlags(token: IntelToken | undefined, now: number): InsiderFlag[] {
  return token?.inspection && !token.inspection.error && freshAt(token.inspection.checkedAt, now, INSPECTION_MAX_AGE) ? token.inspection.flags : [];
}

export function parseHolders(token: string, supplyResult: unknown, largestResult: unknown, accountsResult: unknown, ownerResults: Map<string, unknown>): Holder[] {
  const supply = field(supplyResult, "value", "amount"), precision = field(supplyResult, "value", "decimals");
  if (!raw(supply) || BigInt(supply) <= 0n || !decimals(precision)) throw new Error("Token-Angebot ist nicht bestätigt.");
  const largest = field(largestResult, "value"), accounts = field(accountsResult, "value");
  if (!Array.isArray(largest) || !Array.isArray(accounts) || largest.length !== accounts.length || largest.length > 20) throw new Error("Holder-Antwort unvollständig.");
  const owners = new Map<string, bigint>();
  const seen = new Set<string>();
  for (let i = 0; i < largest.length; i++) {
    const address = field(largest[i], "address"), account = accounts[i], info = field(account, "data", "parsed", "info");
    if (typeof address !== "string" || !isSolanaAddress(address) || seen.has(address)) throw new Error("Doppelte Holder-Konten.");
    seen.add(address);
    // A closed token account is legitimate between two confirmed RPC reads.
    if (account === null) continue;
    const wallet = field(info, "owner"), amount = field(info, "tokenAmount", "amount");
    if (!TOKEN_PROGRAMS.includes(field(account, "owner") as typeof TOKEN_PROGRAMS[number]) || field(info, "mint") !== token || !raw(amount) || field(info, "tokenAmount", "decimals") !== precision || typeof wallet !== "string" || !isSolanaAddress(wallet)) throw new Error("Holder gehört nicht zum geprüften Token.");
    owners.set(wallet, (owners.get(wallet) ?? 0n) + BigInt(amount));
  }
  const total = [...owners.values()].reduce((a, b) => a + b, 0n);
  if (total > BigInt(supply)) throw new Error("Holder-Daten widersprechen dem Token-Angebot.");
  return [...owners].map(([wallet, amount]) => {
    const account = ownerResults.get(wallet), data = field(account, "data");
    const ordinaryWallet = !isOffCurveAddress(wallet as Address) && field(account, "owner") === SYSTEM_PROGRAM && field(account, "executable") === false && Array.isArray(data) && data[0] === "";
    return { wallet, raw: amount.toString(), share: Number(amount * 1_000_000n / BigInt(supply)) / 1_000_000, ordinaryWallet };
  }).sort((a, b) => b.share - a.share);
}

/** A fee payer is labelled launch signer, never silently developer or owner. */
export function launchEvidence(transaction: unknown, token: string): { signer: string | null; funded: string[] } {
  if (field(transaction, "meta", "err") !== null) return { signer: null, funded: [] };
  const message = field(transaction, "transaction", "message"), keys = field(message, "accountKeys");
  const outer = field(message, "instructions"), inner = field(transaction, "meta", "innerInstructions");
  const instructions: unknown[] = Array.isArray(outer) ? [...outer] : [];
  if (Array.isArray(inner)) for (const group of inner) { const rows = field(group, "instructions"); if (Array.isArray(rows)) instructions.push(...rows); }
  const initialized = instructions.some(i => TOKEN_PROGRAMS.includes(field(i, "programId") as typeof TOKEN_PROGRAMS[number]) && ["initializeMint", "initializeMint2"].includes(String(field(i, "parsed", "type"))) && field(i, "parsed", "info", "mint") === token);
  if (!initialized || !Array.isArray(keys)) return { signer: null, funded: [] };
  const signer = keys.find(k => field(k, "signer") === true), wallet = field(signer, "pubkey");
  if (typeof wallet !== "string" || !isSolanaAddress(wallet)) return { signer: null, funded: [] };
  const funded = instructions.filter(i => field(i, "programId") === SYSTEM_PROGRAM && field(i, "parsed", "type") === "transfer" && field(i, "parsed", "info", "source") === wallet && finite(field(i, "parsed", "info", "lamports")) && Number(field(i, "parsed", "info", "lamports")) >= 10_000_000).map(i => String(field(i, "parsed", "info", "destination"))).filter(isSolanaAddress);
  return { signer: wallet, funded: [...new Set(funded)] };
}
export function insiderFlags(holders: readonly Holder[], evidence: ReturnType<typeof launchEvidence>): InsiderFlag[] {
  const flags: InsiderFlag[] = [], ordinary = holders.filter(h => h.ordinaryWallet && h.share > 0);
  const signer = ordinary.find(h => h.wallet === evidence.signer);
  if (signer && signer.share >= 0.05) flags.push({ id: "launch_holder", kind: "launch_link", label: "Launch-Signer hält " + (signer.share * 100).toFixed(1) + "%", detail: "Unterzeichner der bestätigten Mint-Initialisierung hält mindestens 5% des Angebots. Das belegt keinen Informationsvorsprung.", wallets: [signer.wallet] });
  const funded = ordinary.filter(h => evidence.funded.includes(h.wallet) && h.share >= 0.01);
  if (funded.length) flags.push({ id: "launch_funding", kind: "launch_link", label: "Launch-Funding bei " + funded.length + " Holder-Wallets", detail: "Diese Holder (je mindestens 1% des Angebots) erhielten in der Mint-Initialisierung mindestens 0,01 SOL vom Launch-Signer. Gemeinsames Eigentum ist damit nicht bewiesen.", wallets: funded.map(h => h.wallet) });
  const top = ordinary.slice(0, 3), share = top.reduce((sum, h) => sum + h.share, 0);
  if (share >= 0.3) flags.push({ id: "concentration", kind: "distribution", label: "Top-" + top.length + " Wallets halten " + (share * 100).toFixed(1) + "%", detail: "Mindestens 30% des Angebots in bis zu drei als normale Systemkonten bestätigten Wallets. Nur Verteilungsrisiko; kein Insider-Nachweis. Geprüft wird der Ausschnitt der 20 größten Token-Konten.", wallets: top.map(h => h.wallet) });
  return flags;
}

export function parseDexMarkets(body: unknown, requested: ReadonlySet<string>, now: number): Map<string, Partial<IntelToken>> {
  if (!Array.isArray(body)) throw new Error("Kursantwort hat ein unbekanntes Format.");
  const out = new Map<string, Partial<IntelToken>>();
  for (const pair of body) {
    const token = field(pair, "baseToken", "address"), price = Number(field(pair, "priceUsd")), liquidity = field(pair, "liquidity", "usd"), cap = field(pair, "marketCap");
    if (field(pair, "chainId") !== "solana" || typeof token !== "string" || !requested.has(token) || !isSolanaAddress(token) || !Number.isFinite(price) || price <= 0 || !finite(liquidity) || liquidity < 0) continue;
    if ((out.get(token)?.liquidityUsd ?? -1) >= liquidity) continue;
    out.set(token, { symbol: String(field(pair, "baseToken", "symbol") ?? token.slice(0, 6)).slice(0, 40), name: String(field(pair, "baseToken", "name") ?? token.slice(0, 6)).slice(0, 120), priceUsd: price, liquidityUsd: liquidity, marketCap: finite(cap) && cap >= 0 ? cap : null, marketAt: now });
  }
  return out;
}
