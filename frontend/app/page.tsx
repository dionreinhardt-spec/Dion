"use client";

import { useEffect, useRef, useState, useMemo, useCallback } from "react";
import {
  Activity,
  ArrowDownRight,
  ArrowUpRight,
  Bell,
  BellOff,
  Check,
  ChevronDown,
  Copy,
  Crosshair,
  Download,
  ExternalLink,
  Flame,
  Globe2,
  Layers,
  Loader2,
  LockKeyhole,
  Radar,
  Search,
  Settings2,
  ShieldCheck,
  ShieldOff,
  SlidersHorizontal,
  Sparkles,
  SquareTerminal,
  TrendingUp,
  Wallet,
  X,
  Zap,
} from "lucide-react";
import type { Snapshot, Token } from "./types";
import { MobilePositions } from "../components/mobile-positions";
import { MobileScanner } from "../components/mobile-scanner";
import { MobileNavigation } from "../components/mobile-navigation";
import { assertActionAllowed } from "../lib/action-policy";
import { useTerminalConnection } from "../lib/use-terminal-connection";

const NAV = [
  { id: "scanner", label: "Live Scanner", icon: Radar },
  { id: "opportunities", label: "Top Opportunities", icon: Crosshair },
  { id: "wallets", label: "Smart Money Radar", icon: Wallet },
  { id: "social", label: "Social & Narratives", icon: Globe2 },
  { id: "launches", label: "New Launches", icon: Flame },
  { id: "positions", label: "Position Manager", icon: Layers },
  { id: "performance", label: "Performance", icon: TrendingUp },
  { id: "system", label: "System & Sources", icon: SquareTerminal },
];
const WINDOWS = [
  { v: "5", l: "5s" },
  { v: "15", l: "15s" },
  { v: "30", l: "30s" },
  { v: "60", l: "1m" },
  { v: "300", l: "5m" },
  { v: "900", l: "15m" },
  { v: "3600", l: "1h" },
  { v: "86400", l: "24h" },
];
const LABELS: Record<string, string> = {
  capital_inflow: "Capital inflow",
  smart_money: "Smart money",
  holder_growth: "Holder growth",
  volume_acceleration: "Volume acceleration",
  liquidity_quality: "Liquidity quality",
  social_momentum: "Social momentum",
  narrative_strength: "Narrative strength",
  price_structure: "Price structure",
  wallet_distribution: "Wallet distribution",
  market_conditions: "Market conditions",
  token_security: "Token security",
  execution_costs: "Execution costs",
};
function money(n: number | null | undefined, compact = true) {
  return n == null
    ? "—"
    : new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
        notation: compact ? "compact" : "standard",
        maximumFractionDigits: compact ? 2 : 2,
      }).format(n);
}
function price(n: number | null | undefined) {
  return n == null
    ? "—"
    : "$" + n.toLocaleString("en-US", { maximumSignificantDigits: 6 });
}
function pct(n: number | null | undefined) {
  return n == null ? "—" : (n * 100).toFixed(1) + "%";
}
function age(n: number | null | undefined) {
  return n == null ? "—" : n.toFixed(1) + "s";
}
function short(s: string) {
  return s.slice(0, 5) + "…" + s.slice(-4);
}
function when(n: number | null | undefined) {
  return n
    ? new Date(n * 1000).toLocaleTimeString("de-DE", {
        timeZone: "Europe/Berlin",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      })
    : "—";
}
function Empty({
  title,
  detail,
  icon: Icon = Radar,
}: {
  title: string;
  detail: string;
  icon?: typeof Radar;
}) {
  return (
    <div className="empty">
      <div className="empty-icon">
        <Icon size={27} />
      </div>
      <h3>{title}</h3>
      <p>{detail}</p>
    </div>
  );
}
function Badge({ status }: { status: string }) {
  return (
    <span
      className={
        "badge " +
        (status === "ENTRY_CANDIDATE"
          ? "good"
          : status === "BLOCKED"
            ? "warn"
            : "neutral")
      }
    >
      {status === "ENTRY_CANDIDATE" ? "ENTRY CANDIDATE" : status}
    </span>
  );
}
function Score({ value }: { value: number }) {
  return (
    <span
      className={
        "score " + (value >= 62 ? "high" : value >= 40 ? "mid" : "low")
      }
    >
      {value.toFixed(0)}
      <span>/100</span>
    </span>
  );
}

export default function Terminal() {
  const [data, setData] = useState<Snapshot | null>(null),
    [tab, setTab] = useState("scanner"),
    [selected, setSelected] = useState("");
  const [query, setQuery] = useState(""),
    [windowKey, setWindowKey] = useState("30"),
    [filter, setFilter] = useState("all");
  const [apiToken, setApiToken] = useState(""),
    [draftToken, setDraftToken] = useState("");
  const [settings, setSettings] = useState(false),
    [sound, setSound] = useState(false),
    [toast, setToast] = useState("");
  const [watch, setWatch] = useState(""),
    [order, setOrder] = useState<Token | null>(null),
    [amount, setAmount] = useState(""),
    [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<
    Record<string, { t: number; p: number }[]>
  >({});
  const [sessionLocked, setSessionLocked] = useState(false);
  const [isPhone, setIsPhone] = useState(false);
  const [mobileAnalystOpen, setMobileAnalystOpen] = useState(false);
  const [more, setMore] = useState(false);
  useEffect(() => {
    const media = matchMedia(
      "(max-width: 767px), (max-height: 500px) and (pointer: coarse)",
    );
    const update = () => setIsPhone(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    if (!settings && !order && !more && !(isPhone && mobileAnalystOpen)) return;
    const previous = document.activeElement as HTMLElement | null;
    const modal =
      document.querySelector<HTMLElement>(".modal") ||
      document.querySelector<HTMLElement>(".analyst.mobile-open");
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const first = modal?.querySelector<HTMLElement>("button,input,a,select");
    first?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setSettings(false);
        setOrder(null);
        setMore(false);
        setMobileAnalystOpen(false);
      }
      if (e.key === "Tab" && modal) {
        const elements = Array.from(
          modal.querySelectorAll<HTMLElement>(
            "button:not(:disabled),input,a,select",
          ),
        );
        const a = elements[0],
          b = elements.at(-1);
        if (e.shiftKey && document.activeElement === a) {
          e.preventDefault();
          b?.focus();
        } else if (!e.shiftKey && document.activeElement === b) {
          e.preventDefault();
          a?.focus();
        }
      }
    };
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("keydown", key);
      document.body.style.overflow = previousOverflow;
      previous?.focus();
    };
  }, [settings, order, more, mobileAnalystOpen, isPhone]);
  const lastCandidates = useRef(new Set<string>()),
    audioRef = useRef<AudioContext | null>(null),
    soundRef = useRef(false);
  useEffect(() => {
    soundRef.current = sound;
  }, [sound]);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(""), 4500);
    return () => clearTimeout(t);
  }, [toast]);
  const acceptData = useCallback((next: Snapshot) => {
    if (!next.scanner || !next.system)
      throw new Error("Ungültige Serverantwort");
    setData(next);
    setHistory((prev) => {
      const out: Record<string, { t: number; p: number }[]> =
        Object.fromEntries(
          next.scanner.map((coin) => [coin.token, prev[coin.token] || []]),
        );
      for (const coin of next.scanner) {
        if (coin.price_usd && coin.last_event_at) {
          const rows = out[coin.token] || [];
          if (rows.at(-1)?.t !== coin.last_event_at)
            out[coin.token] = [
              ...rows,
              { t: coin.last_event_at, p: coin.price_usd },
            ].slice(-120);
        }
      }
      return out;
    });
    const candidates = new Set(
      next.scanner
        .filter((c) => c.status === "ENTRY_CANDIDATE")
        .map((c) => c.token),
    );
    if (
      soundRef.current &&
      next.system.last_tick_at !== null &&
      next.server_time - next.system.last_tick_at <= 5 &&
      [...candidates].some((c) => !lastCandidates.current.has(c)) &&
      audioRef.current
    ) {
      const ctx = audioRef.current,
        oscillator = ctx.createOscillator(),
        gain = ctx.createGain();
      oscillator.connect(gain);
      gain.connect(ctx.destination);
      oscillator.frequency.value = 680;
      gain.gain.setValueAtTime(0.08, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.22);
      oscillator.start();
      oscillator.stop(ctx.currentTime + 0.22);
    }
    lastCandidates.current = candidates;
  }, []);
  const connection = useTerminalConnection(apiToken, acceptData, sessionLocked);
  const error = connection.error;
  const transport = connection.transport;
  function navigate(next: string) {
    setTab(next);
    setMore(false);
    setMobileAnalystOpen(false);
    if (isPhone) window.scrollTo({ top: 0, behavior: "instant" });
  }
  function selectCoin(token: string) {
    setSelected(token);
    if (isPhone) setMobileAnalystOpen(true);
  }
  function orderKey() {
    if (!window.isSecureContext || !crypto.randomUUID)
      throw new Error("Vertrauenswürdige HTTPS-Verbindung erforderlich");
    return crypto.randomUUID();
  }

  const coins = data?.scanner || [],
    coin = coins.find((c) => c.token === selected) || coins[0];
  const filtered = useMemo(
    () =>
      coins.filter(
        (c) =>
          (c.symbol + " " + c.token)
            .toLowerCase()
            .includes(query.toLowerCase()) &&
          (filter === "all" || c.status === filter) &&
          (tab !== "opportunities" || c.status === "ENTRY_CANDIDATE"),
      ),
    [coins, query, filter, tab],
  );
  const candidates = coins.filter((c) => c.status === "ENTRY_CANDIDATE"),
    portfolio = data?.portfolio;
  async function post(path: string, body?: unknown) {
    assertActionAllowed({
      path,
      fresh: connection.isFresh(),
      visible: !document.hidden,
      online: navigator.onLine,
      locked: sessionLocked,
      secure: window.isSecureContext,
    });
    const r = await fetch(path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(apiToken ? { Authorization: "Bearer " + apiToken } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!r.ok) {
      const j = await r.json();
      throw new Error(
        typeof j.detail === "string" ? j.detail : "Auftrag abgelehnt",
      );
    }
    const result = await r.json();
    if (
      path.startsWith("/api/risk/kill?") &&
      typeof result.kill_switch === "boolean"
    ) {
      setData((previous) =>
        previous
          ? {
              ...previous,
              portfolio: {
                ...previous.portfolio,
                kill_switch: result.kill_switch,
              },
            }
          : previous,
      );
    }
    return result;
  }
  async function action(fn: () => Promise<unknown>, success: string) {
    setBusy(true);
    try {
      await fn();
      setToast(success);
    } catch (e) {
      setToast(e instanceof Error ? e.message : "Aktion fehlgeschlagen");
    } finally {
      setBusy(false);
    }
  }
  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setToast("Contract-Adresse kopiert");
    } catch {
      setToast("Bitte Adresse manuell kopieren: " + text);
    }
  }
  const title = NAV.find((t) => t.id === tab)?.label || "Live Scanner";
  const chart = coin ? history[coin.token] || [] : [];
  const yMax = Math.max(...chart.map((p) => p.p)),
    yMin = Math.min(...chart.map((p) => p.p));
  const path = chart
    .map(
      (p, i) =>
        `${i ? "L" : "M"} ${20 + (i / Math.max(1, chart.length - 1)) * 650} ${140 - ((p.p - yMin) / Math.max(1e-15, yMax - yMin)) * 110}`,
    )
    .join(" ");
  const closed = portfolio?.journal.filter((j) => j.side === "sell") || [],
    wins = closed.filter((j) => (j.realized_pnl_usd || 0) > 0).length;
  const profit = closed.reduce(
      (a, j) => a + Math.max(0, j.realized_pnl_usd || 0),
      0,
    ),
    loss = -closed.reduce(
      (a, j) => a + Math.min(0, j.realized_pnl_usd || 0),
      0,
    );

  return (
    <div className={"terminal" + (!connection.ready ? " feed-stale" : "")}>
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">Λ</div>
          <div>
            AXIOM<span>INTELLIGENCE</span>
          </div>
        </div>
        <div className="workspace-tag">
          <span className="dot" /> PERSONAL WORKSPACE <ChevronDown size={12} />
        </div>
        <div className="nav-caption">MARKET INTELLIGENCE</div>
        <nav>
          {NAV.map((n) => (
            <button
              key={n.id}
              className={tab === n.id ? "active" : ""}
              onClick={() => navigate(n.id)}
            >
              <n.icon size={18} />
              <span>{n.label}</span>
              {n.id === "opportunities" && candidates.length > 0 && (
                <em>{candidates.length}</em>
              )}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="protection">
            <ShieldCheck size={19} />
            <div>
              Capital protection<span>Paper trading only</span>
            </div>
            <LockKeyhole size={13} />
          </div>
          <button className="settings-btn" onClick={() => setSettings(true)}>
            <Settings2 size={17} /> Verbindung & API
          </button>
          <p>
            Independent research terminal
            <br />
            Nicht mit Axiom Trade verbunden.
          </p>
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <a
            className="mobile-brand"
            href="/"
            aria-label="Axiom Intelligence Start"
          >
            <span>Λ</span>
            <b>
              AXIOM<small>INTELLIGENCE</small>
            </b>
          </a>
          <div className="breadcrumb">
            Workspace <span>/</span> <b>{title}</b>
          </div>
          <div className="top-actions">
            <span
              className={
                "connection " + (data?.system.solana.connected ? "online" : "")
              }
            >
              <i />
              {data?.system.solana.connected
                ? "ON-CHAIN CONNECTED"
                : "STREAM OFFLINE"}
            </span>
            <span className="paper-tag">PAPER MODE</span>
            <button
              className="icon-btn"
              aria-label="Sound-Alerts umschalten"
              onClick={() => {
                if (!audioRef.current) audioRef.current = new AudioContext();
                void audioRef.current.resume();
                setSound(!sound);
              }}
            >
              {sound ? <Bell size={17} /> : <BellOff size={17} />}
            </button>
            <button
              className={"kill " + (portfolio?.kill_switch ? "killed" : "")}
              disabled={
                busy ||
                sessionLocked ||
                (!!portfolio?.kill_switch && !connection.ready)
              }
              onClick={() =>
                void action(
                  () =>
                    post("/api/risk/kill?active=" + !portfolio?.kill_switch),
                  portfolio?.kill_switch
                    ? "Paper-Modus fortgesetzt"
                    : "Kill Switch aktiviert",
                )
              }
            >
              <ShieldOff size={14} />
              <span className="kill-label-desktop">
                {portfolio?.kill_switch ? "KILL SWITCH AKTIV" : "KILL SWITCH"}
              </span>
              <span className="kill-label-mobile">
                {portfolio?.kill_switch ? "PAUSIERT" : "PAUSE"}
              </span>
            </button>
            <button
              className="icon-btn phone-settings"
              aria-label="Verbindung und Einstellungen"
              onClick={() => setSettings(true)}
            >
              <Settings2 size={20} />
            </button>
          </div>
        </header>
        <div
          className={
            "mobile-connection-strip" + (connection.ready ? " ready" : "")
          }
        >
          <span>
            <i />
            {connection.ready ? "Verbunden" : "Verbindung prüfen"}
          </span>
          <span>
            {data ? "Stand " + when(data.server_time) : "Noch keine Daten"}
          </span>
        </div>
        <main>
          <div className="page-title">
            <div>
              <div className="eyebrow">
                <span /> SOLANA RESEARCH ENGINE
              </div>
              <h1>
                {title}
                <span className="version">IPHONE</span>
              </h1>
              <p>Kapitalfluss erkennen. Risiken verstehen.</p>
            </div>
            <div className="page-meta">
              <span className="mono">
                {when(data?.server_time)} <small>BERLIN</small>
              </span>
              <span>
                {transport} <i /> Ziel: 1s Neubewertung
              </span>
            </div>
          </div>
          {(error || portfolio?.breaker || portfolio?.kill_switch) && (
            <div className="notice warn">
              <ShieldOff size={16} />
              {error ||
                portfolio?.breaker ||
                "Kill Switch aktiv · Neue Paper-Einstiege und automatische Aktionen pausiert."}
            </div>
          )}
          <div className="stats-grid">
            <div className="stat">
              <span>
                Tracked tokens <Radar size={15} />
              </span>
              <strong>
                {data ? coins.length : "—"}
                <small>SOLANA</small>
              </strong>
              <p>
                <span className="dot" /> Pump / PumpSwap event stream
              </p>
            </div>
            <div className="stat">
              <span>
                Qualified setups <Crosshair size={15} />
              </span>
              <strong className="mint">
                {data ? candidates.length : "—"}
                <small>ENTRY CANDIDATES</small>
              </strong>
              <p>Nach Daten- und Risikoprüfung</p>
            </div>
            <div className="stat">
              <span>
                Paper equity <Wallet size={15} />
              </span>
              <strong>{money(portfolio?.equity_usd, false)}</strong>
              <p>
                Virtuelles Kapital · Netto-PnL{" "}
                <b
                  className={
                    (portfolio?.net_pnl_usd || 0) >= 0 ? "mint" : "red"
                  }
                >
                  {money(portfolio?.net_pnl_usd, false)}
                </b>
              </p>
            </div>
            <div className="stat">
              <span>
                Engine latency <Activity size={15} />
              </span>
              <strong>
                {data?.system.evaluation_ms?.toFixed(1) ?? "—"}
                <small>ms / CYCLE</small>
              </strong>
              <p>Berechnungszeit · keine Netzwerk-Latenz</p>
            </div>
          </div>
          {(tab === "scanner" || tab === "opportunities") && (
            <div className="scanner-layout">
              <div className="scanner-main">
                <section className="panel scanner-panel">
                  <div className="panel-heading">
                    <h2>
                      <Radar size={17} />
                      {tab === "opportunities"
                        ? "Qualified opportunities"
                        : "Live market scanner"}
                      <span className="count">{filtered.length}</span>
                    </h2>
                    <div className="source-badge">
                      <i /> CONFIRMED EVENTS
                    </div>
                  </div>
                  <div className="toolbar">
                    <label className="search">
                      <Search size={15} />
                      <input
                        placeholder="Token oder Contract suchen…"
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                      />
                    </label>
                    <select
                      aria-label="Signalstatus filtern"
                      value={filter}
                      onChange={(e) => setFilter(e.target.value)}
                    >
                      <option value="all">Alle Status</option>
                      <option value="ENTRY_CANDIDATE">Entry candidates</option>
                      <option value="WATCH">Watch</option>
                      <option value="BLOCKED">Blocked</option>
                    </select>
                    <button
                      className="small-btn"
                      onClick={() => setSettings(true)}
                    >
                      <SlidersHorizontal size={14} /> Quellen
                    </button>
                  </div>
                  <div className="windowbar">
                    <span>FLOW WINDOW</span>
                    {WINDOWS.map((w) => (
                      <button
                        key={w.v}
                        className={windowKey === w.v ? "on" : ""}
                        onClick={() => setWindowKey(w.v)}
                      >
                        {w.l}
                      </button>
                    ))}
                  </div>
                  <MobileScanner
                    tokens={filtered}
                    windowKey={windowKey}
                    selected={coin?.token}
                    onSelect={selectCoin}
                  />
                  <div className="table-scroll scanner-desktop-table">
                    <table className="scanner-table">
                      <thead>
                        <tr>
                          <th>Token / Chain</th>
                          <th>Market cap</th>
                          <th>Liquidity</th>
                          <th>Vol. 5m</th>
                          <th>
                            Net inflow{" "}
                            <small>
                              {WINDOWS.find((w) => w.v === windowKey)?.l}
                            </small>
                          </th>
                          <th>Buyers</th>
                          <th>Holders</th>
                          <th>Smart $</th>
                          <th>Score</th>
                          <th>State</th>
                        </tr>
                      </thead>
                      <tbody>
                        {filtered.map((c) => {
                          const f = c.windows[windowKey];
                          return (
                            <tr
                              key={c.token}
                              className={
                                coin?.token === c.token ? "selected" : ""
                              }
                              onClick={() => selectCoin(c.token)}
                            >
                              <td>
                                <button
                                  className="token-select"
                                  onClick={() => selectCoin(c.token)}
                                >
                                  <span className="token-icon">
                                    {c.symbol.slice(0, 2).toUpperCase()}
                                  </span>
                                  <span>
                                    <b>{c.symbol}</b>
                                    <small>SOL · {short(c.token)}</small>
                                  </span>
                                </button>
                              </td>
                              <td>{money(c.market?.market_cap)}</td>
                              <td>{money(c.market?.liquidity_usd)}</td>
                              <td>{money(c.market?.volume_5m)}</td>
                              <td
                                className={
                                  (f.net_flow_usd || 0) >= 0 ? "mint" : "red"
                                }
                              >
                                {f.net_flow_usd != null && f.net_flow_usd > 0
                                  ? "+"
                                  : ""}
                                {money(f.net_flow_usd)}
                              </td>
                              <td>
                                {f.unique_buyers}
                                <small className="dim">
                                  {" "}
                                  / {f.unique_sellers} sell
                                </small>
                              </td>
                              <td className="dim">—</td>
                              <td className="dim">—</td>
                              <td>
                                <Score value={c.score} />
                              </td>
                              <td>
                                <Badge status={c.status} />
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                  {!filtered.length && (
                    <Empty
                      title={
                        tab === "opportunities"
                          ? "Noch kein qualifiziertes Setup"
                          : "Warte auf bestätigte On-Chain-Events"
                      }
                      detail={
                        query
                          ? "Kein Token entspricht deinem Filter."
                          : "RPC-Verbindung und USD-Preise werden geprüft. Hier erscheinen ausschließlich tatsächlich empfangene Daten."
                      }
                    />
                  )}
                  <div className="table-footer">
                    <span>
                      <span className="dot" /> {coins.length} beobachtete Tokens
                      · Keine Vollabdeckung der Chain
                    </span>
                    <span>— = nicht verfügbar</span>
                  </div>
                </section>
                <section className="panel chart-panel">
                  <div className="panel-heading">
                    <h2>
                      <Activity size={17} />
                      {coin
                        ? coin.symbol + " · observed trade price"
                        : "Trade price monitor"}
                    </h2>
                    <span className="dim mono">{price(coin?.price_usd)}</span>
                  </div>
                  {chart.length > 1 ? (
                    <>
                      <svg
                        viewBox="0 0 700 170"
                        role="img"
                        aria-label="Tatsächlich beobachtete Handelspreise in dieser Browser-Sitzung"
                      >
                        <defs>
                          <linearGradient id="fill" x1="0" y1="0" x2="0" y2="1">
                            <stop
                              offset="0%"
                              stopColor="#64e6b5"
                              stopOpacity=".18"
                            />
                            <stop
                              offset="100%"
                              stopColor="#64e6b5"
                              stopOpacity="0"
                            />
                          </linearGradient>
                        </defs>
                        {[30, 70, 110, 150].map((y) => (
                          <line
                            key={y}
                            x1="10"
                            x2="690"
                            y1={y}
                            y2={y}
                            stroke="#252a32"
                            strokeDasharray="3 5"
                          />
                        ))}
                        <path
                          d={path + " L 670 160 L 20 160 Z"}
                          fill="url(#fill)"
                        />
                        <path
                          d={path}
                          fill="none"
                          stroke="#64e6b5"
                          strokeWidth="2"
                        />
                      </svg>
                      <div className="chart-caption">
                        <span>{when(chart[0].t)}</span>
                        <span>
                          Beobachtete Trades dieser Sitzung · Preis in USD ·{" "}
                          {price(yMin)} – {price(yMax)}
                        </span>
                        <span>{when(chart.at(-1)?.t)}</span>
                      </div>
                    </>
                  ) : (
                    <Empty
                      icon={Activity}
                      title="Price discovery starts here"
                      detail="Der Chart entsteht aus empfangenen Trades dieser Browser-Sitzung. Es werden keine historischen Kurse ergänzt."
                    />
                  )}
                </section>
                <div className="bottom-grid">
                  <section className="panel">
                    <div className="panel-heading">
                      <h2>
                        <Zap size={16} />
                        Recent launches
                      </h2>
                      <button
                        className="text-btn"
                        onClick={() => navigate("launches")}
                      >
                        Alle ansehen ↗
                      </button>
                    </div>
                    {data?.launches.length ? (
                      data.launches.slice(0, 4).map((l) => (
                        <button
                          className="feed-row"
                          key={l.signature + l.event}
                          onClick={() => selectCoin(l.token)}
                        >
                          <span className="token-icon small">
                            {l.symbol.slice(0, 2)}
                          </span>
                          <span>
                            <b>{l.symbol}</b>
                            <small>{l.event}</small>
                          </span>
                          <time>{when(l.timestamp)}</time>
                        </button>
                      ))
                    ) : (
                      <div className="mini-empty">
                        Noch keine Create-/Migration-Events empfangen.
                      </div>
                    )}
                  </section>
                  <section className="panel">
                    <div className="panel-heading">
                      <h2>
                        <ShieldCheck size={16} />
                        Risk discipline
                      </h2>
                      <span className="badge neutral">ACTIVE</span>
                    </div>
                    <div className="discipline">
                      <p>
                        <Check size={14} /> Live-Orders technisch nicht
                        verfügbar
                      </p>
                      <p>
                        <Check size={14} /> Veraltete Daten blockieren Einstiege
                      </p>
                      <p>
                        <Check size={14} /> Gebühren & Slippage im Paper-Modell
                      </p>
                      <p>
                        <Check size={14} /> Keine Gewinngarantie oder
                        kalibrierte Prognose
                      </p>
                    </div>
                  </section>
                </div>
              </div>
              {isPhone && mobileAnalystOpen && (
                <button
                  className="analyst-backdrop"
                  aria-label="Analyse schließen"
                  onClick={() => setMobileAnalystOpen(false)}
                />
              )}
              <aside
                className={
                  "panel analyst" + (mobileAnalystOpen ? " mobile-open" : "")
                }
                role={isPhone && mobileAnalystOpen ? "dialog" : undefined}
                aria-modal={isPhone && mobileAnalystOpen ? true : undefined}
                aria-labelledby={
                  isPhone && mobileAnalystOpen ? "analyst-title" : undefined
                }
              >
                <span className="sheet-grip" />
                <div className="panel-heading">
                  <h2 id="analyst-title">
                    <Sparkles size={17} />
                    AI Analyst
                  </h2>
                  <span className="badge neutral">HEURISTIC</span>
                  <button
                    className="icon-btn analyst-close"
                    aria-label="Analyse schließen"
                    onClick={() => setMobileAnalystOpen(false)}
                  >
                    <X size={21} />
                  </button>
                </div>
                {coin ? (
                  <>
                    <div className="analyst-token">
                      <div className="token-icon big">
                        {coin.symbol.slice(0, 2)}
                      </div>
                      <div>
                        <h3>{coin.symbol}</h3>
                        <span>{coin.name} · SOLANA</span>
                      </div>
                      <Score value={coin.score} />
                    </div>
                    <div className="contract">
                      <code>{coin.token}</code>
                      <button
                        aria-label="Contract-Adresse kopieren"
                        onClick={() => copy(coin.token)}
                      >
                        <Copy size={13} />
                      </button>
                    </div>
                    <div className="analyst-state">
                      <Badge status={coin.status} />
                      <span>Risk {coin.risk_score}/100</span>
                    </div>
                    <div className="analyst-stats">
                      <div>
                        <span>Net inflow · 30s</span>
                        <b className="mint">
                          {money(coin.windows["30"].net_flow_usd)}
                        </b>
                      </div>
                      <div>
                        <span>Inflow score</span>
                        <b>{coin.inflow_score}/100</b>
                      </div>
                      <div>
                        <span>Data completeness</span>
                        <b>{coin.data_completeness_pct}%</b>
                      </div>
                      <div>
                        <span>Signal confidence</span>
                        <b>
                          {coin.confidence}% <small>heur.</small>
                        </b>
                      </div>
                    </div>
                    <div className="analyst-section">
                      <h4>SUPPORTING EVIDENCE</h4>
                      {coin.positives.length ? (
                        coin.positives.map((t) => (
                          <p className="evidence" key={t}>
                            <ArrowUpRight size={14} />
                            {t}
                          </p>
                        ))
                      ) : (
                        <p className="dim">
                          Noch keine bestätigenden Faktoren.
                        </p>
                      )}
                    </div>
                    <div className="analyst-section">
                      <h4>RISK & INVALIDATION</h4>
                      {[...coin.blockers, ...coin.warnings]
                        .slice(0, 7)
                        .map((t) => (
                          <p className="evidence negative" key={t}>
                            <ShieldOff size={13} />
                            {t}
                          </p>
                        ))}
                    </div>
                    <div className="analyst-section">
                      <h4>TRANSPARENT SCORE</h4>
                      {Object.entries(coin.contributions).map(([k, v]) => (
                        <div className="factor" key={k}>
                          <span>
                            {LABELS[k] || k}
                            {coin.features[k] == null && <small> n/a</small>}
                          </span>
                          <div>
                            <i
                              style={{
                                width: Math.min(100, (v / 20) * 100) + "%",
                              }}
                            />
                          </div>
                          <b>{v.toFixed(1)}</b>
                        </div>
                      ))}
                    </div>
                    <div className="trade-plan">
                      <h4>PAPER TRADE PLAN</h4>
                      <div>
                        <span>Entry reference</span>
                        <b>{price(coin.price_usd)}</b>
                      </div>
                      <div>
                        <span>Stop scenario</span>
                        <b className="red">{price(coin.plan.stop_price)}</b>
                      </div>
                      <div>
                        <span>Take-profit 1 / 2</span>
                        <b>
                          {price(coin.plan.take_profit[0])} /{" "}
                          {price(coin.plan.take_profit[1])}
                        </b>
                      </div>
                      <div>
                        <span>Max. modeled size</span>
                        <b>{money(coin.plan.max_notional_usd, false)}</b>
                      </div>
                      <small>
                        Manuelle Bestätigung · modellierte Ausführung
                      </small>
                      <button
                        className="primary-btn"
                        disabled={
                          !coin.plan.allowed || busy || !connection.ready
                        }
                        onClick={() => {
                          setOrder(coin);
                          setAmount(
                            String(Math.min(100, coin.plan.max_notional_usd)),
                          );
                        }}
                      >
                        Paper-Einstieg prüfen <ArrowUpRight size={15} />
                      </button>
                    </div>
                    <a
                      className="axiom-link"
                      target="_blank"
                      rel="noopener noreferrer"
                      href={coin.axiom_url}
                    >
                      In Axiom Pulse öffnen <ExternalLink size={13} />
                    </a>
                    <p className="axiom-note">
                      Contract kopieren und in Axiom suchen. Kein verifizierter
                      Token-Deeplink.
                    </p>
                    <div className="freshness">
                      <span>
                        Trade age <b>{age(coin.trade_age_s)}</b>
                      </span>
                      <span>
                        Chain → receipt <b>{age(coin.chain_latency_s)}</b>
                      </span>
                      <span>
                        Metadata received <b>{age(coin.metadata_age_s)}</b>
                      </span>
                      <span>
                        Upstream price timestamp <b>unbekannt</b>
                      </span>
                    </div>
                  </>
                ) : (
                  <Empty
                    icon={Sparkles}
                    title="Evidence before conviction"
                    detail="Wähle einen beobachteten Token für Faktoren, Datenqualität und einen risikobasierten Paper-Plan."
                  />
                )}
              </aside>
            </div>
          )}
          {tab === "positions" && (
            <section className="panel">
              <div className="panel-heading">
                <h2>
                  <Layers size={18} />
                  Paper positions
                </h2>
                <span className="badge neutral">VIRTUAL CAPITAL</span>
              </div>
              {portfolio?.positions.length ? (
                <>
                  <MobilePositions
                    positions={portfolio.positions}
                    disabled={busy || !connection.ready}
                    onClose={(token, fraction) =>
                      void action(
                        () =>
                          post("/api/paper/" + token + "/close", {
                            fraction,
                            idempotency_key: orderKey(),
                          }),
                        "Paper-Exit angefragt",
                      )
                    }
                  />
                  <div className="table-scroll position-desktop-table">
                    <table>
                      <thead>
                        <tr>
                          <th>Token</th>
                          <th>Entry fill</th>
                          <th>Mark</th>
                          <th>Return</th>
                          <th>Unrealized PnL</th>
                          <th>Stop</th>
                          <th>Aktion</th>
                        </tr>
                      </thead>
                      <tbody>
                        {portfolio.positions.map((p) => (
                          <tr key={p.id}>
                            <td>
                              <b>{p.symbol}</b>
                              <small className="block dim">
                                {short(p.token)}
                              </small>
                            </td>
                            <td>{price(p.entry_price)}</td>
                            <td>
                              {price(p.mark)}
                              {p.mark_stale && (
                                <span className="red"> STALE</span>
                              )}
                            </td>
                            <td className={p.return_pct >= 0 ? "mint" : "red"}>
                              {p.return_pct.toFixed(2)}%
                            </td>
                            <td>{money(p.unrealized_pnl_usd, false)}</td>
                            <td>{price(p.stop_price)}</td>
                            <td>
                              <button
                                className="small-btn"
                                disabled={busy || !connection.ready}
                                onClick={() =>
                                  void action(
                                    () =>
                                      post("/api/paper/" + p.token + "/close", {
                                        fraction: 0.5,
                                        idempotency_key: orderKey(),
                                      }),
                                    "50% Paper-Exit angefragt",
                                  )
                                }
                              >
                                50% schließen
                              </button>{" "}
                              <button
                                className="small-btn"
                                disabled={busy || !connection.ready}
                                onClick={() =>
                                  void action(
                                    () =>
                                      post("/api/paper/" + p.token + "/close", {
                                        fraction: 1,
                                        idempotency_key: orderKey(),
                                      }),
                                    "Paper-Position geschlossen",
                                  )
                                }
                              >
                                Schließen
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              ) : (
                <Empty
                  icon={Layers}
                  title="Keine offenen Paper-Positionen"
                  detail="Ein qualifiziertes Setup kann nach manueller Prüfung im Analyst-Panel als Paper-Trade erfasst werden."
                />
              )}
            </section>
          )}
          {tab === "wallets" && (
            <section className="panel">
              <div className="panel-heading">
                <h2>
                  <Wallet size={18} />
                  Observed wallet intelligence
                </h2>
                <span className="badge warn">PARTIAL HISTORY</span>
              </div>
              <div className="info-strip">
                FIFO-Auswertung der beobachteten Swaps mit modellierten
                Gebühren. Keine verifizierten Smart-Money-Rankings; Transfers,
                Funding und vollständige Historie fehlen.
              </div>
              {data?.wallets.length ? (
                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>Wallet</th>
                        <th>Observed realized PnL</th>
                        <th>Lot matches</th>
                        <th>Win rate</th>
                        <th>Median return</th>
                        <th>Profit factor</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.wallets.map((w) => (
                        <tr key={w.wallet}>
                          <td>
                            <button
                              className="text-btn mono"
                              onClick={() => copy(w.wallet)}
                            >
                              {short(w.wallet)} <Copy size={12} />
                            </button>
                          </td>
                          <td>{money(w.observed_realized_pnl_usd, false)}</td>
                          <td>{w.closed_lot_matches}</td>
                          <td>{pct(w.win_rate)}</td>
                          <td>{pct(w.median_return)}</td>
                          <td>{w.profit_factor?.toFixed(2) ?? "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <Empty
                  icon={Wallet}
                  title="Noch keine geschlossenen Lot-Paare"
                  detail="Wallet-Kennzahlen erscheinen nach beobachteten Käufen und dazu passenden Verkäufen. Ein Whale-Kauf allein erzeugt kein Signal."
                />
              )}
            </section>
          )}
          {tab === "social" && (
            <div className="bottom-grid">
              <section className="panel">
                <div className="panel-heading">
                  <h2>
                    <Globe2 size={17} />
                    Narrative monitor
                  </h2>
                  <span className="badge neutral">LEXICAL BASELINE</span>
                </div>
                <div className="info-strip">
                  X: {data?.social.status.x ?? "disabled"} · Telegram:{" "}
                  {data?.social.status.telegram ?? "disabled"}.
                  Account-Unabhängigkeit und organischer Hype sind nicht
                  nachgewiesen.
                </div>
                {data?.social.trends.length ? (
                  data.social.trends.map((t) => (
                    <div className="narrative" key={t.category}>
                      <span className="category-icon">
                        <Flame size={20} />
                      </span>
                      <div>
                        <h3>{t.category}</h3>
                        <p>
                          {t.mentions_10m} Erwähnungen / 10m ·{" "}
                          {t.distinct_accounts} Accounts
                        </p>
                        <small>
                          {t.contracts.length} eindeutige Contract-Adressen
                        </small>
                      </div>
                      <b>{t.growth_ratio?.toFixed(1) ?? "—"}×</b>
                    </div>
                  ))
                ) : (
                  <Empty
                    icon={Globe2}
                    title="Social-Quellen nicht aktiv"
                    detail="X API oder zugelassene Telegram-Channels in der Konfiguration verbinden. Keine erfundenen Trends oder Erwähnungen."
                  />
                )}
              </section>
              <section className="panel">
                <div className="panel-heading">
                  <h2>
                    <Activity size={17} />
                    Received mentions
                  </h2>
                </div>
                {data?.social.recent.length ? (
                  data.social.recent.map((p) => (
                    <article className="social-post" key={p.id}>
                      <div>
                        <span className="badge neutral">{p.platform}</span>
                        <time>{when(p.timestamp)}</time>
                      </div>
                      <p>{p.text}</p>
                      <small>
                        {p.contracts.length
                          ? "Contract-Zuordnung: " +
                            p.contracts.map(short).join(", ")
                          : "Keine eindeutige Contract-Zuordnung"}
                      </small>
                    </article>
                  ))
                ) : (
                  <Empty
                    icon={Activity}
                    title="Noch keine Meldungen"
                    detail="Nur offiziell empfangene Inhalte werden verarbeitet. Ticker-Ähnlichkeit reicht für eine Token-Zuordnung nicht aus."
                  />
                )}
              </section>
            </div>
          )}
          {tab === "launches" && (
            <section className="panel">
              <div className="panel-heading">
                <h2>
                  <Flame size={18} />
                  Launch & migration tracker
                </h2>
                <span className="source-badge">ON-CHAIN EVIDENCE</span>
              </div>
              {data?.launches.length ? (
                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>Token</th>
                        <th>Event</th>
                        <th>Contract</th>
                        <th>Time · Berlin</th>
                        <th>Transaction</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.launches.map((l) => (
                        <tr key={l.signature + l.event}>
                          <td>{l.symbol}</td>
                          <td>{l.event}</td>
                          <td>
                            <button
                              className="text-btn mono"
                              onClick={() => copy(l.token)}
                            >
                              {short(l.token)} <Copy size={12} />
                            </button>
                          </td>
                          <td>{when(l.timestamp)}</td>
                          <td>
                            <a
                              href={"https://solscan.io/tx/" + l.signature}
                              target="_blank"
                              rel="noopener noreferrer"
                            >
                              On-chain prüfen ↗
                            </a>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <Empty
                  icon={Flame}
                  title="Warte auf Launch-Events"
                  detail="Create-, Complete- und PumpSwap-Migration-Events erscheinen nach Empfang über den bestätigten RPC-Stream."
                />
              )}
            </section>
          )}
          {tab === "performance" && (
            <>
              <div className="stats-grid">
                <div className="stat">
                  <span>Realized paper PnL</span>
                  <strong>{money(portfolio?.realized_pnl_usd, false)}</strong>
                  <p>Nach modellierten Kosten</p>
                </div>
                <div className="stat">
                  <span>Winning exit fills</span>
                  <strong>
                    {closed.length ? pct(wins / closed.length) : "—"}
                  </strong>
                  <p>Teil-Exits zählen einzeln</p>
                </div>
                <div className="stat">
                  <span>Profit factor · exit fills</span>
                  <strong>{loss ? (profit / loss).toFixed(2) : "—"}</strong>
                  <p>{closed.length} abgeschlossene Exit-Fills</p>
                </div>
                <div className="stat">
                  <span>Model fees</span>
                  <strong>
                    {money(
                      portfolio?.journal.reduce((a, j) => a + j.fee_usd, 0),
                      false,
                    )}
                  </strong>
                  <p>Kein Nachweis künftiger Performance</p>
                </div>
              </div>
              <section className="panel">
                <div className="panel-heading">
                  <h2>
                    <TrendingUp size={18} />
                    Trading journal
                  </h2>
                  <button
                    className="small-btn"
                    onClick={() => {
                      const blob = new Blob(
                        [JSON.stringify(portfolio?.journal || [], null, 2)],
                        { type: "application/json" },
                      );
                      const u = URL.createObjectURL(blob),
                        a = document.createElement("a");
                      a.href = u;
                      a.download = "paper-journal.json";
                      a.click();
                      URL.revokeObjectURL(u);
                    }}
                  >
                    <Download size={14} /> JSON export
                  </button>
                </div>
                <div className="info-strip">
                  Für Renditeaussagen werden vollständige, kostenbereinigte
                  Out-of-Sample-Daten benötigt. Derzeit liegt kein validierter
                  Renditenachweis vor.
                </div>
                {portfolio?.journal.length ? (
                  <div className="table-scroll">
                    <table>
                      <thead>
                        <tr>
                          <th>Time</th>
                          <th>Side</th>
                          <th>Token</th>
                          <th>Fill</th>
                          <th>Notional</th>
                          <th>Fees</th>
                          <th>Realized PnL</th>
                          <th>Reason</th>
                        </tr>
                      </thead>
                      <tbody>
                        {[...portfolio.journal].reverse().map((j) => (
                          <tr key={j.id + j.side}>
                            <td>{when(j.timestamp)}</td>
                            <td>
                              <span
                                className={
                                  "badge " +
                                  (j.side === "buy" ? "good" : "warn")
                                }
                              >
                                {j.side}
                              </span>
                            </td>
                            <td className="mono">{short(j.token)}</td>
                            <td>{price(j.fill_price)}</td>
                            <td>{money(j.notional_usd, false)}</td>
                            <td>{money(j.fee_usd, false)}</td>
                            <td>{money(j.realized_pnl_usd, false)}</td>
                            <td>{j.reason || "manual entry"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <Empty
                    icon={TrendingUp}
                    title="Dein Journal beginnt mit dem ersten Paper-Trade"
                    detail="Es gibt keine simulierte Gewinnkurve. Jeder erfasste Fill enthält Kosten und Ausführungsannahmen."
                  />
                )}
              </section>
            </>
          )}
          {tab === "system" && (
            <div className="bottom-grid">
              <section className="panel">
                <div className="panel-heading">
                  <h2>
                    <SquareTerminal size={18} />
                    Runtime & sources
                  </h2>
                </div>
                <div className="system-list">
                  {[
                    [
                      "Solana WebSocket",
                      data?.system.solana.connected
                        ? "connected"
                        : "disconnected",
                    ],
                    ["Subscriptions", data?.system.solana.subscriptions],
                    ["Reconnects", data?.system.solana.reconnects],
                    ["Queue depth", data?.system.queue_depth],
                    ["Dropped events", data?.system.solana.dropped],
                    ["Decode / IDL errors", data?.system.solana.decode_errors],
                    [
                      "Unsupported quotes",
                      data?.system.solana.unsupported_quote,
                    ],
                    [
                      "Candidate limit skipped",
                      data?.system.solana.candidate_limit_skipped,
                    ],
                    ["Robinhood adapter", data?.system.robinhood.state],
                    ["Redis hot snapshot", data?.system.cache],
                    [
                      "Configured monthly data cost",
                      money(
                        data?.system.costs.configured_fixed_monthly_usd,
                        false,
                      ),
                    ],
                    [
                      "Estimated variable RPC cost",
                      money(
                        data?.system.costs.estimated_rpc_variable_usd,
                        false,
                      ),
                    ],
                  ].map(([k, v]) => (
                    <div key={k}>
                      <span>{k}</span>
                      <b>{v ?? "—"}</b>
                    </div>
                  ))}
                </div>
                <div className="info-strip">
                  Kosten basieren auf deinen konfigurierten Tarifen. Null ist
                  keine Zusage eines kostenlosen Produktionsbetriebs.
                </div>
                <div className="panel-heading">
                  <h2>Letzte Fehler</h2>
                </div>
                {data?.system.errors
                  .slice(-8)
                  .reverse()
                  .map((e, i) => (
                    <div className="error-row" key={i}>
                      <span>
                        {e.component} · {e.error}
                      </span>
                      <time>{when(e.at)}</time>
                    </div>
                  ))}
              </section>
              <section className="panel">
                <div className="panel-heading">
                  <h2>
                    <ShieldCheck size={18} />
                    Capability manifest
                  </h2>
                </div>
                <div className="capabilities">
                  {Object.entries(data?.capabilities || {}).map(([k, v]) => (
                    <div key={k}>
                      <span>{k.replaceAll("_", " ")}</span>
                      <p>{v}</p>
                    </div>
                  ))}
                </div>
              </section>
            </div>
          )}
          <footer>
            <span>
              AXIOM INTELLIGENCE <b> / </b> INDEPENDENT RESEARCH
            </span>
            <span>
              <LockKeyhole size={11} /> No live execution <i /> Data quality
              over conviction
            </span>
          </footer>
        </main>
      </div>
      <MobileNavigation
        tab={tab}
        navigate={navigate}
        more={more}
        setMore={setMore}
        setups={candidates.length}
        openSettings={() => {
          setMore(false);
          setSettings(true);
        }}
      />
      {toast && (
        <div className="toast" role="status">
          <Activity size={16} />
          {toast}
          <button aria-label="Meldung schließen" onClick={() => setToast("")}>
            <X size={15} />
          </button>
        </div>
      )}
      {settings && (
        <div className="modal-backdrop">
          <section
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="settings-title"
          >
            <button
              className="modal-close"
              aria-label="Schließen"
              onClick={() => setSettings(false)}
            >
              <X size={19} />
            </button>
            <div className="eyebrow">CONNECTION SETTINGS</div>
            <h2 id="settings-title">Deine Datenverbindung</h2>
            <p>
              API-Token bleibt nur im Speicher dieser Browser-Sitzung.
              Provider-Keys werden ausschließlich im Backend konfiguriert.
            </p>
            <label>
              Backend API-Token
              <input
                type="password"
                autoComplete="off"
                value={draftToken}
                onChange={(e) => setDraftToken(e.target.value)}
                placeholder="Optional bei lokalem Betrieb"
              />
            </label>
            <button
              className="small-btn"
              onClick={() => {
                setSessionLocked(false);
                setApiToken(draftToken);
                setToast("Verbindung wird aktualisiert");
              }}
            >
              Verbindung aktualisieren
            </button>
            <button
              className="small-btn session-lock"
              onClick={() => {
                connection.suspend();
                setSessionLocked(true);
                setApiToken("");
                setDraftToken("");
                setData(null);
                setHistory({});
                setToast("Sitzung gesperrt · Token erneut eingeben");
              }}
            >
              Sitzung sperren
            </button>
            <button
              className="small-btn"
              onClick={() => {
                if (!audioRef.current) audioRef.current = new AudioContext();
                void audioRef.current.resume();
                setSound(!sound);
              }}
            >
              {sound ? "Sound im Vordergrund aus" : "Sound im Vordergrund an"}
            </button>
            <a className="small-btn install-settings-link" href="/install">
              iPhone-Installation
            </a>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void action(
                  () => post("/api/watch", { token: watch }),
                  "Token zur Watchlist hinzugefügt",
                );
              }}
            >
              <label>
                Solana-Contract beobachten
                <input
                  className="mono"
                  value={watch}
                  onChange={(e) => setWatch(e.target.value)}
                  placeholder="Vollständige Mint-Adresse"
                  required
                />
              </label>
              <button
                className="primary-btn"
                disabled={busy || !connection.ready}
              >
                Zur Watchlist hinzufügen
              </button>
            </form>
            <div className="info-strip">
              Watchlist ergänzt DEX-Metadaten. On-Chain-Swaps werden aktuell für
              Pump und PumpSwap erfasst. Keine Private Keys erforderlich.
            </div>
          </section>
        </div>
      )}
      {order && (
        <div className="modal-backdrop">
          <section
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="order-title"
          >
            <button
              className="modal-close"
              aria-label="Schließen"
              onClick={() => setOrder(null)}
            >
              <X size={19} />
            </button>
            <div className="eyebrow">MANUAL PAPER CONFIRMATION</div>
            <h2 id="order-title">{order.symbol} · Paper-Einstieg</h2>
            <p>
              Virtuelle Position mit modellierten Kosten. Preis, Signal und
              Risikolimits werden beim Absenden erneut geprüft.
            </p>
            <code className="order-contract">{order.token}</code>
            <label>
              Positionsgröße · USD
              <input
                type="number"
                min="1"
                max={order.plan.max_notional_usd}
                step="0.01"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </label>
            <div className="system-list">
              <div>
                <span>Maximaler Betrag</span>
                <b>{money(order.plan.max_notional_usd, false)}</b>
              </div>
              <div>
                <span>Gebühr pro Seite</span>
                <b>
                  {order.plan.fee_bps_per_side} bps +{" "}
                  {money(order.plan.priority_fee_usd_per_side, false)}
                </b>
              </div>
              <div>
                <span>Basis-Slippage</span>
                <b>{order.plan.slippage_bps_base} bps + modellierter Impact</b>
              </div>
            </div>
            <button
              className="primary-btn"
              disabled={
                busy ||
                !connection.ready ||
                !Number.isFinite(Number(amount)) ||
                Number(amount) <= 0
              }
              onClick={() =>
                void action(async () => {
                  await post("/api/paper/buy", {
                    token: order.token,
                    notional_usd: Number(amount),
                    idempotency_key: orderKey(),
                  });
                  setOrder(null);
                }, "Paper-Position eröffnet")
              }
            >
              {busy ? (
                <Loader2 className="spin" size={16} />
              ) : (
                <Check size={16} />
              )}
              Paper-Einstieg bestätigen
            </button>
          </section>
        </div>
      )}
    </div>
  );
}
