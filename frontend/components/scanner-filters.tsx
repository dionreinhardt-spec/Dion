"use client";
import { Crosshair, Flame, Radar, RotateCcw, Search, SlidersHorizontal, TrendingUp } from "lucide-react";
import {
  DEFAULT_SCANNER_FILTERS, FLOW_WINDOWS, windowLabel,
  type ScannerFilterState, type ScannerPreset, type ScannerSort,
} from "../lib/scanner-filters";

const PRESETS = [
  { id: "all", label: "Alle Tokens", icon: Radar },
  { id: "trending", label: "Jetzt im Trend", icon: Flame },
  { id: "inflow", label: "Kapitalzufluss", icon: TrendingUp },
  { id: "entries", label: "Entry-Kandidaten", icon: Crosshair },
] as const;

export function ScannerFilters({ value, onChange, count, total, ready }: {
  value: ScannerFilterState;
  onChange(next: ScannerFilterState): void;
  count: number;
  total: number;
  ready: boolean;
}) {
  const change = (patch: Partial<ScannerFilterState>) => onChange({ ...value, ...patch });
  const preset = (next: ScannerPreset) => change({
    preset: next, status: "all", sort: next === "entries" ? "score" : next === "inflow" ? "inflow" : "buyers",
    ...(next === "trending" ? { windowKey: "60", minBuyers: 100 } : {}),
  });
  return (
    <div className="scanner-controls">
      <label className="scanner-search">
        <Search size={17} aria-hidden="true" />
        <input aria-label="Token oder Contract suchen" placeholder="Token oder Contract suchen …" value={value.query}
          onChange={event => change({ query: event.target.value })} autoComplete="off" />
        {value.query && <button type="button" onClick={() => change({ query: "" })} aria-label="Suche leeren">×</button>}
      </label>
      <div className="scanner-presets" role="group" aria-label="Schnellfilter">
        {PRESETS.map(item => (
          <button type="button" key={item.id} aria-pressed={value.preset === item.id}
            className={value.preset === item.id ? "active" : ""} onClick={() => preset(item.id)}>
            <item.icon size={16} aria-hidden="true" /><span>{item.label}</span>
          </button>
        ))}
      </div>
      <div className="scanner-time-sort">
        <div className="scanner-time" role="group" aria-label="Zeitfenster">
          <span>Zeitraum</span>
          {["30", "60", "300", "900"].map(key => (
            <button type="button" key={key} aria-pressed={value.windowKey === key}
              className={value.windowKey === key ? "active" : ""} onClick={() => change({ windowKey: key })}>{windowLabel(key)}</button>
          ))}
        </div>
        <label className="scanner-sort"><span>Sortieren</span>
          <select aria-label="Tokens sortieren" value={value.sort} onChange={event => change({ sort: event.target.value as ScannerSort })}>
            <option value="buyers">Meiste Käufer-Wallets</option><option value="inflow">Höchster Nettozufluss</option>
            <option value="volume">Höchstes Volumen · 5m</option><option value="liquidity">Höchste Liquidität</option><option value="score">Höchster Score</option>
          </select>
        </label>
      </div>
      <details className="scanner-advanced">
        <summary><SlidersHorizontal size={15} aria-hidden="true" /> Weitere Filter <span>Schwelle, Liquidität, Status</span></summary>
        <div className="scanner-advanced-grid">
          <label>Trend: mindestens Käufer-Wallets
            <select value={value.minBuyers} onChange={event => change({ minBuyers: Number(event.target.value) })}>
              {[10, 25, 50, 100, 250, 500, 1000].map(n => <option key={n} value={n}>{n} verschiedene Wallets</option>)}
            </select>
          </label>
          <label>Mindestliquidität
            <select value={value.minLiquidity} onChange={event => change({ minLiquidity: Number(event.target.value) })}>
              <option value="0">Alle · auch unbekannt</option>
              {[10000, 25000, 50000, 100000].map(n => <option key={n} value={n}>Mindestens ${n.toLocaleString("en-US")}</option>)}
            </select>
          </label>
          <label>Signalstatus
            <select value={value.status} onChange={event => change({ status: event.target.value })}>
              <option value="all">Alle Status</option><option value="ENTRY_CANDIDATE">Entry-Kandidat</option><option value="WATCH">Beobachten</option><option value="BLOCKED">Gesperrt</option>
            </select>
          </label>
          <label>Alle Zeitfenster
            <select value={value.windowKey} onChange={event => change({ windowKey: event.target.value })}>
              {FLOW_WINDOWS.map(window => <option key={window.value} value={window.value}>{window.label}</option>)}
            </select>
          </label>
        </div>
        <label className="scanner-check"><input type="checkbox" checked={value.hideSuspicious} onChange={event => change({ hideSuspicious: event.target.checked })} />
          Bei Trend und Zufluss: auffällige Rundkäufe oder starke Volumenkonzentration ausblenden
        </label>
      </details>
      <div className={"scanner-filter-explanation" + (value.preset === "trending" ? " trending" : "")}>
        <strong>{value.preset === "trending" ? `Mindestens ${value.minBuyers} Käufer-Wallets in ${windowLabel(value.windowKey)}`
          : value.preset === "inflow" ? `Positiver Nettozufluss in ${windowLabel(value.windowKey)}`
          : value.preset === "entries" ? "Nur vom Backend freigegebene Entry-Kandidaten" : "Deine beobachteten Tokens"}</strong>
        <p>{value.preset === "trending" ? "Verschiedene Wallet-Adressen, keine belegte Personenzahl. Letzter Trade höchstens 15 Sekunden alt. Trend ist kein Kaufsignal."
          : value.preset === "inflow" ? "Mindestens 80 % der beobachteten Trades mit USD-Bewertung. Letzter Trade höchstens 15 Sekunden alt."
          : "Sortierung und Filter gelten für den beobachteten Ausschnitt, nicht für alle Tokens der Chain."}</p>
        {!ready && value.preset !== "all" && <p className="scanner-stale-note">Pausiert: Für diesen Filter fehlen gerade frische On-Chain-Daten.</p>}
      </div>
      <div className="scanner-filter-result"><span>{count} von {total} beobachteten Tokens</span>
        <button type="button" onClick={() => onChange({ ...DEFAULT_SCANNER_FILTERS })}><RotateCcw size={13} aria-hidden="true" /> Zurücksetzen</button>
      </div>
    </div>
  );
}
