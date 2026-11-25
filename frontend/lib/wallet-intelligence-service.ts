import { isSolanaAddress } from "./coin-chart.ts";
import { WALLET_REGISTRY } from "./wallet-registry.ts";
import { TOKEN_PROGRAMS, record, field, finite, contextSlot, parseWalletBalances, holdingsForToken, parseHolders, launchEvidence, insiderFlags, parseDexMarkets, freshAt, type WalletLabel, type WalletScan, type IntelToken, type Inspection, type IntelligenceSnapshot } from "./wallet-intelligence.ts";

type Options = { fetcher?: typeof fetch; now?: () => number; rpcUrl?: string; backendUrl?: string; backendToken?: string; labels?: readonly WalletLabel[]; rpcBudget?: number; fullHolders?: boolean; verifyGenesis?: boolean };
type Launch = { signature: string; timestamp: number };
export class IntelligenceError extends Error { retryAfter: number; constructor(message: string, retryAfter = 60) { super(message); this.retryAfter = retryAfter; } }

export function createIntelligenceService(options: Options = {}) {
  const fetcher = options.fetcher ?? fetch, now = options.now ?? (() => Date.now() / 1000);
  const rpcUrl = options.rpcUrl ?? process.env.WALLET_INTEL_RPC_URL ?? "https://api.mainnet-beta.solana.com";
  const backend = options.backendUrl ?? process.env.BACKEND_URL ?? "http://127.0.0.1:8000";
  const labels = options.labels ?? WALLET_REGISTRY;
  const fullHolders = options.fullHolders ?? process.env.WALLET_INTEL_FULL_HOLDERS === "1";
  const budget = Math.max(8, Math.min(40, Math.floor(options.rpcBudget ?? 24)));
  const scans = new Map<string, WalletScan>(), attempts = new Map<string, number>(), scanErrors = new Map<string, string>();
  const tokens = new Map<string, IntelToken>(), inspected = new Map<string, Inspection>(), launches = new Map<string, Launch>(), observed = new Set<string>();
  const inspectedTried = new Map<string, number>(), metadataTried = new Map<string, number>();
  let genesisChecked = false, genesisCheck: Promise<void> | null = null, inspectionPausedUntil = 0;
  let calls: number[] = [], metadataCalls: number[] = [], cooldown = 0, rpcErrors = 0, lastRpcSuccess: number | null = null;
  let sourceAt: number | null = null, sourceError: string | null = null, metadataError: string | null = null, busy = false, running = false, turn = 0, rpcId = 0;
  const startedAt = now();
  let timer: ReturnType<typeof setInterval> | undefined;

  async function json(url: string, init: RequestInit = {}, maxBytes = 12_000_000): Promise<unknown> {
    const response = await fetcher(url, { ...init, cache: "no-store", signal: AbortSignal.timeout(10_000) });
    if (!response.ok) {
      const retry = response.headers.get("retry-after"), seconds = retry ? Number(retry) || (Date.parse(retry) - Date.now()) / 1000 : 60;
      if (response.status === 429) throw new IntelligenceError("Rate-Limit der Datenquelle erreicht.", Math.min(3600, Math.max(60, seconds)));
      throw new IntelligenceError("Datenquelle antwortet mit HTTP " + response.status + ".");
    }
    if (Number(response.headers.get("content-length")) > maxBytes) throw new IntelligenceError("Datenantwort überschreitet das Größenlimit.");
    const reader = response.body?.getReader();
    if (!reader) throw new IntelligenceError("Datenantwort fehlt.");
    const parts: Uint8Array[] = []; let length = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) { await reader.cancel(); throw new IntelligenceError("Datenantwort überschreitet das Größenlimit."); }
      parts.push(value);
    }
    try { return JSON.parse(Buffer.concat(parts).toString("utf8")); } catch { throw new IntelligenceError("Unbekanntes Datenformat."); }
  }
  async function rpc(method: string, params: unknown[]): Promise<unknown> {
    if (method !== "getGenesisHash" && options.verifyGenesis !== false && !genesisChecked) {
      genesisCheck ??= (async () => {
        const hash = await rpc("getGenesisHash", []);
        if (hash !== "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d") throw new IntelligenceError("RPC ist nicht als Solana Mainnet bestätigt.");
        genesisChecked = true;
      })().catch(error => { genesisCheck = null; cooldown = Math.max(cooldown, now() + 60); throw error; });
      await genesisCheck;
    }
    const time = now(); calls = calls.filter(t => time - t < 60);
    if (time < cooldown || calls.length >= budget) throw new IntelligenceError("RPC-Budget pausiert bis zum nächsten freien Zeitfenster.", Math.ceil(Math.max(1, cooldown - time, (calls[0] ?? time) + 60 - time)));
    calls.push(time); const id = ++rpcId;
    try {
      const body = await json(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) });
      if (field(body, "id") !== id || field(body, "jsonrpc") !== "2.0") throw new IntelligenceError("RPC-Antwort ist nicht eindeutig zugeordnet.");
      if (field(body, "error")) { const code = field(body, "error", "code"); throw new IntelligenceError(code === 429 || code === -32429 ? "RPC-Rate-Limit erreicht." : "RPC-Methode derzeit nicht verfügbar.", code === 429 || code === -32429 ? 90 : 60); }
      if (!("result" in record(body))) throw new IntelligenceError("RPC-Ergebnis fehlt.");
      lastRpcSuccess = now(); return field(body, "result");
    } catch (error) {
      rpcErrors++;
      const failure = error instanceof IntelligenceError ? error : new IntelligenceError("RPC-Verbindung fehlgeschlagen oder Timeout.");
      cooldown = Math.max(cooldown, now() + failure.retryAfter);
      throw failure;
    }
  }
  function blank(token: string, symbol = token.slice(0, 6)): IntelToken { return { token, chain: "solana", symbol, name: symbol, priceUsd: null, liquidityUsd: null, marketCap: null, marketAt: null, kol: [], inspection: null }; }

  async function refreshSource() {
    try {
      const headers: Record<string, string> = { accept: "application/json" }, apiToken = options.backendToken ?? process.env.WALLET_INTEL_BACKEND_TOKEN;
      if (apiToken) headers.authorization = "Bearer " + apiToken;
      const body = await json(backend.replace(/\/$/, "") + "/api/snapshot", { headers });
      const rows = field(body, "scanner"), current = field(body, "server_time");
      if (!Array.isArray(rows) || !finite(current) || !freshAt(current, now(), 30)) throw new IntelligenceError("Scanner-Quelle ist veraltet oder unvollständig.");
      observed.clear();
      for (const row of rows.slice(0, 500)) {
        const token = field(row, "token");
        if (field(row, "chain") !== "solana" || typeof token !== "string" || !isSolanaAddress(token)) continue;
        observed.add(token);
        const previous = tokens.get(token) ?? blank(token), market = field(row, "market"), marketAt = field(market, "received_at");
        previous.symbol = String(field(row, "symbol") ?? previous.symbol).slice(0, 40); previous.name = String(field(row, "name") ?? previous.name).slice(0, 120);
        if (field(market, "token") === token && finite(marketAt) && freshAt(marketAt, now(), 300) && finite(field(market, "price_usd"))) {
          previous.priceUsd = Number(field(market, "price_usd")); previous.marketAt = marketAt;
          previous.liquidityUsd = finite(field(market, "liquidity_usd")) ? Number(field(market, "liquidity_usd")) : null;
          previous.marketCap = finite(field(market, "market_cap")) ? Number(field(market, "market_cap")) : null;
        }
        tokens.set(token, previous);
      }
      const recent = field(body, "launches");
      if (Array.isArray(recent)) for (const launch of recent) {
        const token = field(launch, "token"), signature = field(launch, "signature"), timestamp = field(launch, "timestamp");
        if (field(launch, "event") !== "CreateEvent" || typeof token !== "string" || !isSolanaAddress(token) || typeof signature !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(signature) || !finite(timestamp) || !freshAt(timestamp, now(), 86400)) continue;
        launches.set(token, { signature, timestamp });
        if (!tokens.has(token)) tokens.set(token, blank(token, String(field(launch, "symbol") ?? token.slice(0, 6)).slice(0, 40)));
      }
      while (launches.size > 300) launches.delete(launches.keys().next().value!);
      sourceAt = current; sourceError = null;
    } catch { sourceError = "Scanner-Daten momentan nicht verfügbar. Geprüfte Wallet-Bestände laufen separat weiter."; }
  }

  async function scanWallet(label: WalletLabel) {
    attempts.set(label.wallet, now()); let failure: string | null = null;
    for (const program of TOKEN_PROGRAMS) {
      const key = label.wallet + ":" + program, previous = scans.get(key);
      try {
        const result = await rpc("getTokenAccountsByOwner", [label.wallet, { programId: program }, { encoding: "jsonParsed", commitment: "confirmed" }]);
        const slot = contextSlot(result), balances = parseWalletBalances(result, label.wallet, program);
        if (previous && slot < previous.slot) throw new IntelligenceError("RPC lieferte einen älteren Wallet-Slot.");
        scans.set(key, { wallet: label.wallet, program, checkedAt: now(), slot, balances, error: null });
        for (const mint of Object.keys(balances)) if (!tokens.has(mint) && tokens.size < 2500) tokens.set(mint, blank(mint));
      } catch (error) { failure = error instanceof IntelligenceError ? error.message : "Token-Konten konnten nicht vollständig zugeordnet werden."; }
    }
    if (failure) scanErrors.set(label.wallet, failure); else scanErrors.delete(label.wallet);
  }

  async function discoverMarkets() {
    const time = now(); metadataCalls = metadataCalls.filter(t => time - t < 60);
    if (metadataCalls.length >= 6) return;
    const wanted = new Set<string>();
    for (const scan of scans.values()) if (freshAt(scan.checkedAt, time)) for (const mint of Object.keys(scan.balances)) {
      if (wanted.size >= 30) break;
      if (tokens.get(mint)?.marketAt && freshAt(tokens.get(mint)!.marketAt!, time, 300)) continue;
      if (time - (metadataTried.get(mint) ?? 0) >= (tokens.get(mint)?.marketAt ? 300 : 900)) wanted.add(mint);
    }
    if (!wanted.size) return;
    metadataCalls.push(time); for (const mint of wanted) metadataTried.set(mint, time);
    try {
      const body = await json("https://api.dexscreener.com/tokens/v1/solana/" + [...wanted].join(","), {}, 2_000_000);
      const markets = parseDexMarkets(body, wanted, now());
      for (const [mint, market] of markets) tokens.set(mint, { ...(tokens.get(mint) ?? blank(mint)), ...market });
      metadataError = null;
    } catch { metadataError = "Bewertung einzelner Wallet-Bestände fehlt. Unbewertete Bestände sind separat einblendbar."; }
    while (metadataTried.size > 6000) metadataTried.delete(metadataTried.keys().next().value!);
  }

  async function inspectToken(token: string) {
    inspectedTried.set(token, now());
    try {
      if (!fullHolders) {
        const launch = launches.get(token);
        if (!launch) throw new IntelligenceError("Keine bestätigbare Launch-Signatur im beobachteten Ausschnitt.");
        const tx = await rpc("getTransaction", [launch.signature, { encoding: "jsonParsed", commitment: "confirmed", maxSupportedTransactionVersion: 1 }]);
        const evidence = launchEvidence(tx, token);
        if (!evidence.signer) throw new IntelligenceError("Mint-Initialisierung und Launch-Signer sind nicht eindeutig bestätigt.");
        const supply = await rpc("getTokenSupply", [token, { commitment: "confirmed" }]);
        const selectedWallets = [...new Set([evidence.signer, ...evidence.funded])].slice(0, 3);
        const accountRows: unknown[] = [], slots = [contextSlot(supply)];
        for (const wallet of selectedWallets) {
          const body = await rpc("getTokenAccountsByOwner", [wallet, { mint: token }, { encoding: "jsonParsed", commitment: "confirmed" }]);
          const values = field(body, "value");
          if (!Array.isArray(values)) throw new IntelligenceError("Launch-Bestände unvollständig.");
          const program = values.length ? field(values[0], "account", "owner") : TOKEN_PROGRAMS[0];
          if (!TOKEN_PROGRAMS.includes(program as typeof TOKEN_PROGRAMS[number])) throw new IntelligenceError("Launch-Tokenprogramm unbekannt.");
          parseWalletBalances(body, wallet, String(program));
          if (values.some(row => field(row, "account", "data", "parsed", "info", "mint") !== token)) throw new IntelligenceError("Launch-Bestand gehört zu einem anderen Mint.");
          accountRows.push(...values); slots.push(contextSlot(body));
        }
        if (accountRows.length > 20) throw new IntelligenceError("Launch-Kontenausschnitt überschreitet das Limit.");
        const ownerResults = new Map<string, unknown>();
        if (accountRows.length) {
          const ownerBody = await rpc("getMultipleAccounts", [selectedWallets, { encoding: "base64", dataSlice: { offset: 0, length: 1 }, commitment: "confirmed", minContextSlot: Math.max(...slots) }]);
          const values = field(ownerBody, "value");
          if (!Array.isArray(values) || values.length !== selectedWallets.length) throw new IntelligenceError("Launch-Wallet-Typen nicht bestätigt.");
          selectedWallets.forEach((wallet, index) => ownerResults.set(wallet, values[index])); slots.push(contextSlot(ownerBody));
        }
        if (Math.max(...slots) - Math.min(...slots) > 300) throw new IntelligenceError("Launch-Bestände liegen zeitlich zu weit auseinander.");
        const holders = parseHolders(token, supply, { value: accountRows.map(row => ({ address: field(row, "pubkey") })) }, { value: accountRows.map(row => field(row, "account")) }, ownerResults);
        inspected.set(token, { token, checkedAt: now(), slotMin: Math.min(...slots), slotMax: Math.max(...slots), top3Share: null, coverage: "launch_wallets", holders, launchSigner: evidence.signer, launchSignature: launch.signature, flags: insiderFlags(holders, evidence).filter(flag => flag.kind === "launch_link"), error: null });
        while (inspected.size > 250) inspected.delete(inspected.keys().next().value!);
        return;
      }
      const supply = await rpc("getTokenSupply", [token, { commitment: "confirmed" }]);
      const largest = await rpc("getTokenLargestAccounts", [token, { commitment: "confirmed" }]);
      const rows = field(largest, "value");
      if (!Array.isArray(rows) || !rows.length || rows.length > 20) throw new IntelligenceError("Kein gültiger Holder-Ausschnitt.");
      const addresses = rows.map(row => field(row, "address"));
      if (!addresses.every(address => typeof address === "string" && isSolanaAddress(address))) throw new IntelligenceError("Holder-Adressen ungültig.");
      const accounts = await rpc("getMultipleAccounts", [addresses, { encoding: "jsonParsed", commitment: "confirmed", minContextSlot: contextSlot(largest) }]);
      const values = field(accounts, "value");
      if (!Array.isArray(values) || values.length !== addresses.length) throw new IntelligenceError("Holder-Konten unvollständig.");
      const owners = [...new Set(values.map(account => field(account, "data", "parsed", "info", "owner")).filter((owner): owner is string => typeof owner === "string" && isSolanaAddress(owner)))];
      if (!owners.length) throw new IntelligenceError("Keine zugeordneten Holder-Wallets.");
      const ownerBody = await rpc("getMultipleAccounts", [owners, { encoding: "base64", dataSlice: { offset: 0, length: 1 }, commitment: "confirmed", minContextSlot: contextSlot(accounts) }]);
      const ownerValues = field(ownerBody, "value");
      if (!Array.isArray(ownerValues) || ownerValues.length !== owners.length) throw new IntelligenceError("Wallet-Typen unvollständig.");
      const ownerResults = new Map(owners.map((owner, i) => [owner, ownerValues[i]]));
      const holders = parseHolders(token, supply, largest, accounts, ownerResults);
      let evidence: ReturnType<typeof launchEvidence> = { signer: null, funded: [] }, launchSignature: string | null = null;
      const launch = launches.get(token);
      if (launch) {
        try { const tx = await rpc("getTransaction", [launch.signature, { encoding: "jsonParsed", commitment: "confirmed", maxSupportedTransactionVersion: 1 }]); evidence = launchEvidence(tx, token); if (evidence.signer) launchSignature = launch.signature; } catch { /* Distribution can still be checked; no launch attribution is invented. */ }
      }
      const slots = [contextSlot(supply), contextSlot(largest), contextSlot(accounts), contextSlot(ownerBody)];
      if (Math.max(...slots) - Math.min(...slots) > 300) throw new IntelligenceError("Holder-Lesezeitpunkte liegen zu weit auseinander.");
      inspected.set(token, { token, checkedAt: now(), slotMin: Math.min(...slots), slotMax: Math.max(...slots), top3Share: holders.filter(h => h.ordinaryWallet).slice(0, 3).reduce((sum, h) => sum + h.share, 0), coverage: "top20", holders, launchSigner: evidence.signer, launchSignature, flags: insiderFlags(holders, evidence), error: null });
    } catch (error) {
      const previous = inspected.get(token);
      if (previous) inspected.set(token, { ...previous, error: error instanceof IntelligenceError ? error.message : "Holder-Antwort nicht eindeutig zugeordnet." });
      else inspected.set(token, { token, checkedAt: 0, slotMin: 0, slotMax: 0, top3Share: null, coverage: fullHolders ? "top20" : "launch_wallets", holders: [], launchSigner: null, launchSignature: null, flags: [], error: error instanceof IntelligenceError ? error.message : "Holder-Daten unvollständig." });
      inspectionPausedUntil = Math.max(inspectionPausedUntil, now() + 120);
    }
    while (inspected.size > 250) inspected.delete(inspected.keys().next().value!);
  }

  async function tick() {
    if (busy) return; busy = true;
    try {
      await refreshSource();
      const time = now(), dueWallet = labels.filter(label => time - (attempts.get(label.wallet) ?? 0) >= 300).sort((a, b) => (attempts.get(a.wallet) ?? 0) - (attempts.get(b.wallet) ?? 0))[0];
      const dueTokens = time < inspectionPausedUntil ? [] : [...tokens.keys()].filter(mint => time - (inspectedTried.get(mint) ?? 0) >= 600 && (fullHolders ? observed.has(mint) || launches.has(mint) : launches.has(mint)) && mint !== "So11111111111111111111111111111111111111112" && mint !== "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
      dueTokens.sort((a, b) => (launches.get(b)?.timestamp ?? 0) - (launches.get(a)?.timestamp ?? 0) || (tokens.get(b)?.liquidityUsd ?? 0) - (tokens.get(a)?.liquidityUsd ?? 0));
      calls = calls.filter(t => time - t < 60);
      if (time >= cooldown) {
        if (dueWallet && (turn++ % 2 === 0 || !dueTokens.length) && budget - calls.length >= 2) await scanWallet(dueWallet);
        else if (dueTokens.length && budget - calls.length >= (fullHolders ? 5 : 6)) await inspectToken(dueTokens[0]);
      }
      await discoverMarkets();
      if (tokens.size > 2500) for (const [mint] of tokens) { if (tokens.size <= 2000) break; if (!observed.has(mint) && !launches.has(mint)) tokens.delete(mint); }
      while (inspectedTried.size > 2500) inspectedTried.delete(inspectedTried.keys().next().value!);
    } catch { sourceError = "Analyse-Zyklus vorübergehend eingeschränkt. Es werden keine Ersatzwerte erzeugt."; }
    finally { busy = false; }
  }

  function snapshot(): IntelligenceSnapshot {
    const time = now(), currentScans = [...scans.values()], heldMints = new Set<string>();
    for (const scan of currentScans) if (freshAt(scan.checkedAt, time)) for (const mint of Object.keys(scan.balances)) heldMints.add(mint);
    const reports: IntelToken[] = [];
    for (const token of tokens.values()) {
      const price = token.marketAt !== null && freshAt(token.marketAt, time, 300) ? token.priceUsd : null;
      const kol = heldMints.has(token.token) ? holdingsForToken(token.token, labels, currentScans, time, price) : [];
      const inspection = inspected.get(token.token) ?? null;
      if (observed.has(token.token) || kol.length || inspection?.flags.length) reports.push({ ...token, priceUsd: price, marketCap: price !== null ? token.marketCap : null, liquidityUsd: price !== null ? token.liquidityUsd : null, kol, inspection });
    }
    reports.sort((a, b) => Number(observed.has(b.token)) - Number(observed.has(a.token)) || Math.max(0, ...b.kol.map(h => h.valueUsd ?? 0)) - Math.max(0, ...a.kol.map(h => h.valueUsd ?? 0)));
    const wallets = labels.map(label => {
      const rows = currentScans.filter(scan => scan.wallet === label.wallet && freshAt(scan.checkedAt, time));
      return { ...label, checkedAt: rows.length ? Math.min(...rows.map(row => row.checkedAt)) : null, programsChecked: rows.length, complete: rows.length === TOKEN_PROGRAMS.length, nonzeroMints: new Set(rows.flatMap(row => Object.keys(row.balances))).size, error: scanErrors.get(label.wallet) ?? null };
    });
    const pending = [...heldMints].filter(mint => { const received = tokens.get(mint)?.marketAt; return received == null || !freshAt(received, time, 300); }).length;
    return { serverTime: time, startedAt, sourceAt, wallets, tokens: reports.slice(0, 750), status: { running, rpcCallsLastMinute: calls.filter(t => time - t < 60).length, rpcBudget: budget, rpcErrors, lastRpcSuccess, sourceError, metadataError, holderMode: fullHolders ? "top20" : "launch_wallets", inspected: [...inspected.values()].filter(row => row.checkedAt > 0 && !row.error && freshAt(row.checkedAt, time, 900)).length, observedTokens: observed.size, metadataPending: pending }, scope: "Öffentliche Anbieter-Zuordnungen; bestätigte RPC-Bestände von 8 ausgewählten Wallets, kein Kaufnachweis. Insider-Radar: " + (fullHolders ? "Launch-Bezüge und Top-20-Verteilung" : "bis zu drei Wallets je bestätigtem Launch; Top-20-Holder nicht aktiviert") + "; keine bewiesenen Insider und keine Kaufempfehlung." };
  }
  function start() { if (running) return; running = true; void tick(); timer = setInterval(() => void tick(), 15_000); timer.unref?.(); }
  function stop() { running = false; clearInterval(timer); }
  return { start, stop, tick, snapshot, rpc, scanWallet, inspectToken, refreshSource };
}

const processCache = globalThis as typeof globalThis & { axiomWalletIntelligence?: ReturnType<typeof createIntelligenceService> };
export function intelligenceService() { return processCache.axiomWalletIntelligence ??= createIntelligenceService(); }
