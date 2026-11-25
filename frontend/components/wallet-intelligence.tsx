"use client";
import { useMemo, useState } from "react";
import { Activity, ArrowUpRight, Clock3, ExternalLink, Radar, Search, ShieldAlert, Users, Wallet } from "lucide-react";
import { activeHoldings, currentFlags, freshAt, type IntelligenceSnapshot, type IntelToken } from "../lib/wallet-intelligence";

const usd = (value: number | null | undefined) => value == null ? "—" : new Intl.NumberFormat("de-DE", { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 1 }).format(value);
const when = (value: number | null) => value ? new Date(value * 1000).toLocaleString("de-DE", { timeZone: "Europe/Berlin", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "Noch nicht geprüft";
const short = (value: string) => value.slice(0, 5) + "…" + value.slice(-4);

export function WalletMarks({ token, now, showEmpty = false }: { token?: IntelToken; now: number; showEmpty?: boolean }) {
  const holdings = activeHoldings(token, now), flags = currentFlags(token, now), names = [...new Set(holdings.map(h => h.name))];
  if (!names.length && !flags.length) return showEmpty ? <span className="intel-no-match" title="Kein aktueller bestätigter Treffer im geprüften Ausschnitt. Fehlende oder unvollständige Prüfung ist keine Entwarnung.">—</span> : null;
  return <span className="intel-marks">
    {names.slice(0, 2).map(name => <span key={name} className="intel-mark kol" title={`${name}: RPC-Bestand ab 25 USD. Zuordnung laut Solana Tracker; Kauf ungeprüft.`}><Wallet size={11} />{name}<small>Bestand</small></span>)}
    {names.length > 2 && <span className="intel-mark kol">+{names.length - 2}</span>}
    {flags.length > 0 && <span className="intel-mark insider" title={flags.map(f => f.label + ": " + f.detail).join("\n")}><ShieldAlert size={11} />{flags.some(f => f.kind === "launch_link") ? "Launch-Bezug" : "Holder-Warnung"}</span>}
  </span>;
}

export function WalletIntelligencePanel({ mode, snapshot, error, now, onChart }: { mode: "kol" | "insiders"; snapshot: IntelligenceSnapshot | null; error: string; now: number; onChart(token: IntelToken): void }) {
  const [query, setQuery] = useState(""), [trader, setTrader] = useState("all"), [includeUnpriced, setIncludeUnpriced] = useState(false), [riskKind, setRiskKind] = useState("all");
  const [visible, setVisible] = useState(30);
  const all = snapshot?.tokens ?? [], labels = snapshot?.wallets ?? [];
  const names = [...new Set(labels.map(label => label.name))];
  const freshService = !!snapshot && freshAt(snapshot.serverTime, now, 90);
  const checked = labels.filter(label => label.complete && label.checkedAt !== null && freshAt(label.checkedAt, now)).length;
  const kolCount = all.filter(t => activeHoldings(t, now).length).length, insiderCount = all.filter(t => currentFlags(t, now).length).length;
  const filtered = useMemo(() => {
    const search = query.trim().toLowerCase();
    return all.filter(token => {
      if (search && !`${token.symbol} ${token.name} ${token.token}`.toLowerCase().includes(search)) return false;
      if (mode === "kol") return activeHoldings(token, now, includeUnpriced).some(h => trader === "all" || h.name === trader);
      const flags = currentFlags(token, now);
      return flags.some(flag => riskKind === "all" || flag.kind === riskKind);
    }).sort((a, b) => mode === "kol" ? Math.max(0, ...b.kol.map(h => h.valueUsd ?? 0)) - Math.max(0, ...a.kol.map(h => h.valueUsd ?? 0)) : Number(currentFlags(b, now).some(f => f.kind === "launch_link")) - Number(currentFlags(a, now).some(f => f.kind === "launch_link")) || (b.inspection?.checkedAt ?? 0) - (a.inspection?.checkedAt ?? 0));
  }, [all, query, mode, now, includeUnpriced, trader, riskKind]);
  return <div className="intel-workspace">
    <section className="panel intel-hero">
      <div className="intel-hero-heading"><div><span className="eyebrow">WALLET INTELLIGENCE</span><h2>{mode === "kol" ? <Users size={24} /> : <ShieldAlert size={24} />}{mode === "kol" ? "KOL-Wallets" : "Insider-Radar"}</h2><p>{mode === "kol" ? "Welche ausgewählten Trader-Wallets halten einen Coin?" : "Bestände und Verbindungen rund um neue Token-Launches prüfen."}</p></div><span className={"badge " + (freshService && checked ? "good" : "warn")}>{freshService && checked ? "RPC-BESTÄNDE" : "PRÜFUNG LÄUFT"}</span></div>
      <div className="intel-principle">{mode === "kol" ? "Ein Bestand belegt keinen Kauf: Tokens können geschenkt oder als Spam übertragen worden sein. Ab 25 USD, nach aktueller öffentlicher Kursbewertung. Namen sind Anbieter-Zuordnungen, keine signierten Eigentumsnachweise." : "Ein Treffer ist ein Prüfhinweis, kein bewiesener Insider und kein Kaufsignal. Launch-Bezüge und reine Verteilungsrisiken werden getrennt ausgewiesen. Wallet-Verbindungen belegen kein gemeinsames Eigentum."}</div>
      <div className="intel-stats"><div><strong>{checked}<small> / {labels.length || 8}</small></strong><span>Wallets vollständig geprüft</span></div><div><strong>{mode === "kol" ? kolCount : insiderCount}</strong><span>{mode === "kol" ? "Coins mit Bestand ab 25 USD" : "Coins mit aktuellen Hinweisen"}</span></div><div><strong>{snapshot?.status.inspected ?? 0}</strong><span>Aktuelle Launch-/Holder-Prüfungen</span></div><div><strong>{snapshot?.sourceAt ? when(snapshot.sourceAt) : "—"}</strong><span>Scanner-Stand · Berlin</span></div></div>
      {(error || snapshot?.status.sourceError || snapshot?.status.metadataError || !freshService) && <p className="intel-status" role="status">{error || snapshot?.status.sourceError || snapshot?.status.metadataError || "Die ersten Prüfungen laufen. Nur empfangene Ergebnisse erscheinen; kein Treffer kann auch fehlende Abdeckung bedeuten."}</p>}
    </section>
    <section className="panel intel-results">
      <div className="panel-heading"><h2><Radar size={18} />{mode === "kol" ? "Coins in beobachteten Wallets" : "Prüfhinweise"}<span className="count">{filtered.length}</span></h2></div>
      <div className="intel-controls"><label className="intel-search"><Search size={16} /><input type="search" placeholder="Token oder Contract suchen" aria-label={mode === "kol" ? "KOL-Coins suchen" : "Insider-Radar durchsuchen"} value={query} onChange={event => setQuery(event.target.value)} /></label>
        {mode === "kol" ? <label className="intel-select">Trader<select aria-label="Trader filtern" value={trader} onChange={event => setTrader(event.target.value)}><option value="all">Alle Trader</option>{names.map(name => <option key={name} value={name}>{name}</option>)}</select></label> : <label className="intel-select">Hinweis<select aria-label="Insider-Hinweise filtern" value={riskKind} onChange={event => setRiskKind(event.target.value)}><option value="all">Alle Hinweise</option><option value="launch_link">Launch-Bezüge</option><option value="distribution" disabled={snapshot?.status.holderMode !== "top20"}>{snapshot?.status.holderMode === "top20" ? "Nur Verteilungsrisiken" : "Top-20-Verteilung nicht aktiviert"}</option></select></label>}
        {mode === "kol" && <label className="intel-toggle"><input type="checkbox" checked={includeUnpriced} onChange={event => setIncludeUnpriced(event.target.checked)} />Unbewertete Bestände anzeigen</label>}
      </div>
      {!filtered.length ? <div className="intel-empty"><Radar size={32} /><h3>{snapshot?.status.lastRpcSuccess ? "Noch keine passenden Treffer" : "Warte auf bestätigte RPC-Daten"}</h3><p>{mode === "kol" ? "Wallet-Prüfungen und Kursbewertungen laufen nacheinander. Restbestände unter 25 USD sind ausgeblendet. Unbewertete Bestände lassen sich separat einblenden." : "Nur geprüfte Bezüge oder Verteilungsrisiken erscheinen hier. Ungeprüfte Coins sind nicht automatisch unauffällig."}</p></div> : <div className="intel-coin-grid">{filtered.slice(0, visible).map(token => {
        const holdings = activeHoldings(token, now, includeUnpriced), flags = currentFlags(token, now), inspection = token.inspection;
        return <article className="intel-coin" key={token.token}>
          <div className="intel-coin-head"><span className="token-icon">{token.symbol.slice(0, 2)}</span><div><h3>{token.symbol}</h3><small>{token.name}</small></div><span className="badge neutral">SOLANA</span></div>
          <WalletMarks token={token} now={now} />
          <p className="intel-contract">{token.token}</p>
          <div className="intel-market"><span>Market Cap<b>{usd(token.marketCap)}</b></span><span>Liquidität<b>{usd(token.liquidityUsd)}</b></span></div>
          <p className="intel-market-time">Kursdaten empfangen: {when(token.marketAt)} · Provider-Zeitpunkt des Kurses unbekannt</p>
          {mode === "kol" ? <div className="intel-holdings">{[...new Set(holdings.map(h => h.name))].map(name => { const rows = holdings.filter(h => h.name === name); const known = rows.every(h => h.valueUsd !== null); return <div key={name}><b><Wallet size={13} />{name}</b><span>{rows.length} Wallet{rows.length > 1 ? "s" : ""} · {known ? usd(rows.reduce((sum, h) => sum + (h.valueUsd ?? 0), 0)) : "Wert offen"}</span></div>; })}<p>Bestand bestätigt · Kauf und Einstandspreis ungeprüft</p></div> : <div className="intel-flags">{flags.map(flag => <div key={flag.id}><span className={"intel-risk-kind " + flag.kind}>{flag.kind === "launch_link" ? "LAUNCH-BEZUG" : "VERTEILUNG"}</span><b>{flag.label}</b><p>{flag.detail}</p></div>)}</div>}
          <details className="intel-evidence"><summary>Belege & Wallets <ArrowUpRight size={14} /></summary>
            {mode === "kol" ? holdings.map(holding => <div className="intel-proof" key={holding.wallet}><b>{holding.name} · {short(holding.wallet)}</b><span>≈ {new Intl.NumberFormat("de-DE", { maximumSignificantDigits: 6 }).format(Number(holding.raw) / 10 ** holding.decimals)} Token · Slot {holding.slot}</span><span><Clock3 size={11} /> Bestand geprüft: {when(holding.checkedAt)}</span><span>Zuordnung geprüft: {holding.labelCheckedAt}</span><code>Rohbestand: {holding.raw} · {holding.decimals} Dezimalstellen</code><div><a href={holding.source} target="_blank" rel="noopener noreferrer">Namensquelle <ExternalLink size={12} /></a><a href={"https://solscan.io/account/" + holding.wallet} target="_blank" rel="noopener noreferrer">Wallet ansehen <ExternalLink size={12} /></a></div></div>) : <div className="intel-proof"><span>Holder-Prüfung: {when(inspection?.checkedAt ?? null)}</span><span>Bestätigte Slots: {inspection?.slotMin}–{inspection?.slotMax}</span><span>{inspection?.coverage === "top20" ? "Bis zu 20 größte Token-Konten, nach Wallet gruppiert; Pool- und Programmkonten ausgeschlossen." : "Gezielte Prüfung von bis zu drei Wallets aus der Mint-Initialisierung; keine vollständige Holder-Prüfung."}</span>{inspection?.launchSignature ? <a href={"https://solscan.io/tx/" + inspection.launchSignature} target="_blank" rel="noopener noreferrer">Mint-Initialisierung ansehen <ExternalLink size={12} /></a> : <span>Keine bestätigte Launch-Transaktion zugeordnet.</span>}{[...new Set(flags.flatMap(flag => flag.wallets))].map(wallet => <a key={wallet} href={"https://solscan.io/account/" + wallet} target="_blank" rel="noopener noreferrer">{short(wallet)} <ExternalLink size={12} /></a>)}</div>}
          </details>
          <div className="intel-coin-footer"><span><Clock3 size={12} />{when(mode === "kol" ? Math.min(...holdings.map(h => h.checkedAt)) : inspection?.checkedAt ?? null)}</span><button type="button" className="coin-chart-btn" aria-label={"Chart für " + token.symbol + " öffnen"} onClick={() => onChart(token)}><Activity size={14} /> Chart</button></div>
        </article>;
      })}</div>}
      {filtered.length > visible && <button type="button" className="load-more small-btn" onClick={() => setVisible(previous => previous + 30)}>Weitere {Math.min(30, filtered.length - visible)} Coins anzeigen</button>}
      <p className="intel-scope">Abdeckung: ausgewählte öffentliche Wallets und ein priorisierter Token-Ausschnitt. {snapshot?.status.holderMode === "top20" ? "Die Top-20-Prüfung erfasst nur einen Holder-Ausschnitt." : "Derzeit werden gezielt Launch-Wallets geprüft; die Top-20-Prüfung ist deaktiviert."} Ein neuer Bestand kann bereits vorher existiert haben. Keine automatische Orderausführung. Die bisherigen Risiko- und Datensperren gelten weiter.</p>
    </section>
    <details className="panel intel-source-details"><summary>Verfolgte Wallets & Datenqualität <span>{labels.length} Wallets · {names.length} Namen</span></summary><div className="intel-registry">{labels.map(label => <div key={label.wallet}><div><b>{label.name}</b><span className={"badge " + (label.complete ? "good" : "warn")}>{label.complete ? "GEPRÜFT" : label.programsChecked ? "TEILWEISE" : "AUSSTEHEND"}</span></div><code>{label.wallet}</code><p>{when(label.checkedAt)} · {label.nonzeroMints} nichtleere Mints · {label.programsChecked}/2 Token-Programme</p>{label.error && <p className="intel-status">{label.error}</p>}{label.note && <p>{label.note}</p>}<a href={label.source} target="_blank" rel="noopener noreferrer">Solana Tracker · Zuordnung vom {label.labelCheckedAt} <ExternalLink size={12} /></a></div>)}</div><p className="intel-scope">RPC-Aufrufe in 60s: {snapshot?.status.rpcCallsLastMinute ?? 0}/{snapshot?.status.rpcBudget ?? 24} · Fehler: {snapshot?.status.rpcErrors ?? 0} · Letzte erfolgreiche RPC-Antwort: {when(snapshot?.status.lastRpcSuccess ?? null)} · Noch ohne Kurszuordnung: {snapshot?.status.metadataPending ?? 0}. Die kostenlose öffentliche RPC hat keine garantierte Verfügbarkeit. Namenszuordnungen können veralten; nicht alle Wallets einer Person sind bekannt. Vollständige Funding-Cluster und historische Einstiegspunkte sind nicht erfasst.</p></details>
  </div>;
}
