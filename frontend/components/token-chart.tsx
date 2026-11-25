"use client";
import { useEffect, useRef, useState } from "react";
import { CandlestickSeries, HistogramSeries, ColorType, CrosshairMode, createChart, type IChartApi, type ISeriesApi, type UTCTimestamp, type Time } from "lightweight-charts";
import { Activity, ExternalLink, Loader2, Maximize2, RefreshCw } from "lucide-react";
import { CHART_INTERVALS, readChartData, type ChartInterval, type ChartSelection, type CoinChartData } from "../lib/coin-chart";
const dateTime = (seconds: number) => new Intl.DateTimeFormat("de-DE", { timeZone: "Europe/Berlin", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(seconds * 1000));
const chartTime = (time: Time) => typeof time === "number" ? dateTime(time) : String(time);
const quote = (value: number) => new Intl.NumberFormat("de-DE", { maximumSignificantDigits: 7 }).format(value);

export default function TokenChart({ selection }: { selection: ChartSelection }) {
  const [interval, setInterval] = useState<ChartInterval>("1m");
  const [data, setData] = useState<CoinChartData | null>(null);
  const [phase, setPhase] = useState<"loading" | "refreshing" | "ready" | "error" | "paused">("loading");
  const [message, setMessage] = useState("");
  const [drawError, setDrawError] = useState("");
  const element = useRef<HTMLDivElement>(null), chart = useRef<IChartApi | null>(null);
  const candles = useRef<ISeriesApi<"Candlestick"> | null>(null), volume = useRef<ISeriesApi<"Histogram"> | null>(null);
  const fitted = useRef(false), refresh = useRef<() => void>(() => {});

  useEffect(() => {
    if (!element.current) return;
    const instance = createChart(element.current, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: "#0d121a" }, textColor: "#a6b6cc", attributionLogo: true },
      grid: { vertLines: { color: "#1a2431" }, horzLines: { color: "#1a2431" } },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: "#283443", scaleMargins: { top: 0.08, bottom: 0.25 } },
      timeScale: { borderColor: "#283443", timeVisible: true, secondsVisible: false, tickMarkFormatter: (time: Time) => typeof time === "number" ? new Intl.DateTimeFormat("de-DE", { timeZone: "Europe/Berlin", hour: "2-digit", minute: "2-digit", day: undefined, month: undefined }).format(new Date(time * 1000)) : "" },
      localization: { locale: "de-DE", timeFormatter: chartTime, priceFormatter: (value: number) => "$" + quote(value) },
      handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
      handleScale: { axisPressedMouseMove: true, mouseWheel: true, pinch: true },
    });
    const candleSeries = instance.addSeries(CandlestickSeries, { upColor: "#64e6b5", downColor: "#f17e89", wickUpColor: "#64e6b5", wickDownColor: "#f17e89", borderVisible: false, priceFormat: { type: "price", precision: 10, minMove: 0.0000000001 } });
    const volumeSeries = instance.addSeries(HistogramSeries, { priceScaleId: "volume", priceFormat: { type: "volume" }, lastValueVisible: false, priceLineVisible: false });
    volumeSeries.priceScale().applyOptions({ scaleMargins: { top: 0.8, bottom: 0 }, visible: false });
    chart.current = instance; candles.current = candleSeries; volume.current = volumeSeries;
    return () => { instance.remove(); chart.current = null; candles.current = null; volume.current = null; };
  }, []);

  useEffect(() => {
    chart.current?.applyOptions({ timeScale: { tickMarkFormatter: (time: Time) => typeof time === "number" ? new Intl.DateTimeFormat("de-DE", { timeZone: "Europe/Berlin", hour: interval === "1d" ? undefined : "2-digit", minute: interval === "1d" ? undefined : "2-digit", day: interval === "1d" ? "2-digit" : undefined, month: interval === "1d" ? "2-digit" : undefined }).format(new Date(time * 1000)) : "" } });
    fitted.current = false; candles.current?.setData([]); volume.current?.setData([]); setData(null); setDrawError("");
    let disposed = false, epoch = 0, controller: AbortController | null = null, timer: ReturnType<typeof setTimeout> | undefined;
    let hasData = false;
    const cancel = () => { epoch++; controller?.abort(); clearTimeout(timer); };
    const load = async () => {
      clearTimeout(timer);
      if (disposed) return;
      if (document.hidden || !navigator.onLine) { setPhase("paused"); setMessage("Chart-Updates pausiert. Bereits geladene Kerzen bleiben als Historie sichtbar."); return; }
      const request = ++epoch;
      controller?.abort(); controller = new AbortController();
      setPhase(hasData ? "refreshing" : "loading"); setMessage("");
      let retryIn = 60_000;
      try {
        const response = await fetch(`/api/charts/${encodeURIComponent(selection.chain.toLowerCase())}/${encodeURIComponent(selection.token)}?interval=${interval}`, { cache: "no-store", headers: { accept: "application/json" }, signal: controller.signal });
        if (!response.headers.get("content-type")?.includes("application/json")) throw new Error("Der Chart-Dienst hat momentan keine gültige Datenantwort geliefert.");
        const body = await response.json();
        if (!response.ok) { retryIn = Math.max(60_000, Number(body.retryAfter || 60) * 1000); throw new Error(typeof body.error === "string" ? body.error : "Der Chart konnte nicht geladen werden."); }
        const received = readChartData(body, selection, interval);
        if (disposed || request !== epoch) return;
        hasData = true; setData(received); setPhase("ready"); setMessage(received.warning ?? "");
      } catch (error) {
        if (disposed || request !== epoch || (error instanceof Error && error.name === "AbortError")) return;
        setPhase("error"); setMessage(error instanceof Error ? error.message : "Die Chart-Datenquelle ist momentan nicht erreichbar.");
      } finally {
        if (!disposed && request === epoch && !document.hidden && navigator.onLine) timer = setTimeout(() => void load(), retryIn);
      }
    };
    const resume = () => { cancel(); if (document.hidden || !navigator.onLine) { setPhase("paused"); setMessage("Chart-Updates pausiert. Geladene Kerzen sind historische Daten."); } else void load(); };
    refresh.current = resume;
    document.addEventListener("visibilitychange", resume); window.addEventListener("online", resume); window.addEventListener("offline", resume);
    void load();
    return () => { disposed = true; cancel(); refresh.current = () => {}; document.removeEventListener("visibilitychange", resume); window.removeEventListener("online", resume); window.removeEventListener("offline", resume); };
  }, [selection.chain, selection.token, interval]);

  useEffect(() => {
    if (!data || !candles.current || !volume.current) return;
    try {
      candles.current.setData(data.candles.map(bar => ({ time: bar.time as UTCTimestamp, open: bar.open, high: bar.high, low: bar.low, close: bar.close })));
      volume.current.setData(data.candles.map(bar => ({ time: bar.time as UTCTimestamp, value: bar.volume, color: bar.close >= bar.open ? "rgba(100,230,181,0.28)" : "rgba(241,126,137,0.28)" })));
      if (!fitted.current && data.candles.length) { chart.current?.timeScale().fitContent(); fitted.current = true; }
      setDrawError("");
    } catch { setDrawError("Diese Kerzendaten konnten nicht sicher gezeichnet werden."); }
  }, [data]);

  const latest = data?.candles.at(-1), busy = phase === "loading" || phase === "refreshing";
  return (
    <div className="token-chart-content">
      <div className="token-chart-toolbar">
        <div className="token-chart-intervals" role="group" aria-label="Chart-Zeitfenster">
          {CHART_INTERVALS.map(item => <button type="button" key={item.value} aria-pressed={interval === item.value} className={interval === item.value ? "active" : ""} onClick={() => setInterval(item.value)}>{item.label}</button>)}
        </div>
        <div className="token-chart-tools">
          <button type="button" onClick={() => chart.current?.timeScale().fitContent()} aria-label="Chart-Ansicht zurücksetzen"><Maximize2 size={15} /> Ansicht</button>
          <button type="button" disabled={busy || phase === "paused"} onClick={() => refresh.current()} aria-label="Chart-Daten aktualisieren"><RefreshCw size={15} className={busy ? "chart-spin" : ""} /> Aktualisieren</button>
        </div>
      </div>
      <div className="token-chart-summary" aria-live="polite">
        <strong>{latest ? "$" + quote(latest.close) : "—"}<small>USD · {selection.symbol}</small></strong>
        <span>{busy ? "Daten werden geladen …" : data?.stale || phase === "error" ? "Update eingeschränkt" : phase === "paused" ? "Updates pausiert" : "Pool-Kerzen · OHLCV"}</span>
      </div>
      <div className="tradingview-chart-wrap">
        <div ref={element} className="tradingview-canvas" aria-label={`TradingView-Kerzenchart für ${selection.symbol}, Contract ${selection.token}`} />
        {!data && <div className="chart-empty-overlay" role="status">{busy ? <Loader2 className="chart-spin" size={27} /> : <Activity size={27} />}<b>{busy ? "Lade passende Pool-Kerzen" : "Noch keine Kerzendaten verfügbar"}</b><span>{message || "Der Pool wird anhand der Contract-Adresse geprüft."}</span></div>}
        {data && !data.candles.length && <div className="chart-empty-overlay"><Activity size={27} /><b>Noch keine Kerzen in diesem Zeitfenster</b><span>Der Provider hat für diesen Pool noch keine Kerzen geliefert.</span></div>}
      </div>
      {(message || drawError) && data && <div className="chart-data-warning" role="status">{drawError || message} Bereits geladene Kerzen sind historische Daten; sie werden nicht als neuer Live-Kurs ausgegeben.</div>}
      <div className="token-chart-freshness"><span>Empfangen: {data ? dateTime(data.fetchedAt) : "—"}</span><span>Letzte Kerze: {latest ? dateTime(latest.time) : "—"}</span><span>Zeiten: Berlin · Prüfung alle 60s</span></div>
      {data && <div className="token-chart-pool"><div><b>{data.pool.dex} · {data.pool.tokenSide === "base" ? "Basis-Token" : "Quote-Token"}</b><span>Pool: {data.pool.address}</span></div><a href={data.pool.url} target="_blank" rel="noopener noreferrer">Pool ansehen <ExternalLink size={13} /></a></div>}
      <p className="token-chart-attribution">Chart: <a href="https://www.tradingview.com/" target="_blank" rel="noopener noreferrer">TradingView Lightweight Charts™</a> · Kursdaten: <a href="https://www.geckoterminal.com/" target="_blank" rel="noopener noreferrer">GeckoTerminal</a>. Es werden bis zu 200 echte Pool-Kerzen gezeigt. Kein sekündlicher Echtzeit-Feed; Daten können verzögert oder bei neuen Tokens noch nicht verfügbar sein.</p>
    </div>
  );
}
