"use strict";

const elements = {
  body: document.body,
  connectionDot: document.querySelector("#connection-dot"),
  connectionLabel: document.querySelector("#connection-label"),
  modeBadge: document.querySelector("#mode-badge"),
  scanButton: document.querySelector("#scan-button"),
  paperButton: document.querySelector("#paper-button"),
  scanLabel: document.querySelector("#scan-label"),
  paperLabel: document.querySelector("#paper-label"),
  sourceLine: document.querySelector("#source-line"),
  notice: document.querySelector("#notice"),
  planBody: document.querySelector("#plan-body"),
  tableSummary: document.querySelector("#table-summary"),
  searchInput: document.querySelector("#search-input"),
  actionFilter: document.querySelector("#action-filter"),
  strategyFilter: document.querySelector("#strategy-filter"),
  chartTabs: document.querySelector("#chart-tabs"),
  chartStage: document.querySelector("#chart-stage"),
  chartCount: document.querySelector("#chart-count"),
  portfolioPositions: document.querySelector("#portfolio-positions"),
  portfolioStatus: document.querySelector("#portfolio-status"),
  activityLog: document.querySelector("#activity-log"),
  timestampLine: document.querySelector("#timestamp-line"),
  toast: document.querySelector("#toast"),
};

let currentPayload = null;
let toastTimer = null;

const labels = {
  strategies: {
    MOMENTUM_BREAKOUT: "Momentum Breakout",
    TREND_PULLBACK: "Trend Pullback",
    RANGE_MEAN_REVERSION: "Mean Reversion",
    CASH_DEFENSIVE: "Cash Defensive",
    UNSPECIFIED: "Nicht bestimmt",
  },
  regimes: {
    BULL_TREND: "Bull Trend",
    BEAR_TREND: "Bear Trend",
    RANGE_MIXED: "Range / Mixed",
    HIGH_VOLATILITY: "Hohe Volatilität",
    UNSPECIFIED: "Nicht bestimmt",
  },
  actions: {
    PAPER_BUY: "Paper Buy",
    NO_TRADE_MODEL_GATE: "Modell blockiert",
    NO_TRADE_BACKTEST_GATE: "Backtest blockiert",
    WATCH_PROBABILITY: "Wahrscheinlichkeit zu klein",
    WATCH_NO_SETUP: "Kein Chart-Setup",
    WATCH_STRATEGY_GATE: "Strategie blockiert",
    WATCH_POSITION_LIMIT: "Positionslimit",
    WATCH_EXPOSURE_LIMIT: "Exposure-Limit",
  },
};

function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function formatPercent(value, digits = 1) {
  return finite(value)
    ? new Intl.NumberFormat("de-DE", { style: "percent", minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value)
    : "—";
}

function formatDecimal(value, digits = 3) {
  return finite(value)
    ? new Intl.NumberFormat("de-DE", { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value)
    : "—";
}

function formatPrice(value, currency = "USD") {
  if (!finite(value)) return "—";
  const decimals = value < 0.01 ? 8 : value < 1 ? 5 : value < 100 ? 3 : 2;
  return `${new Intl.NumberFormat("de-DE", { maximumFractionDigits: decimals }).format(value)} ${currency}`;
}

function formatMoney(value, currency = "USD") {
  if (!finite(value)) return "—";
  return new Intl.NumberFormat("de-DE", {
    style: "currency",
    currency,
    maximumFractionDigits: 2,
  }).format(value);
}

function formatTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("de-DE", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function setText(selector, value) {
  const node = document.querySelector(selector);
  if (node) node.textContent = value;
}

function setTone(node, value) {
  node.classList.remove("positive", "negative");
  if (!finite(value) || value === 0) return;
  node.classList.add(value > 0 ? "positive" : "negative");
}

function showToast(message, isError = false) {
  window.clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.classList.toggle("error", isError);
  elements.toast.classList.add("show");
  toastTimer = window.setTimeout(() => elements.toast.classList.remove("show"), 4200);
}

function showNotice(message, isError = false) {
  if (!message) {
    elements.notice.classList.add("hidden");
    return;
  }
  elements.notice.textContent = message;
  elements.notice.classList.remove("hidden");
  elements.notice.classList.toggle("error", isError);
}

function setLoading(loading, mode = "scan") {
  elements.body.classList.toggle("loading", loading);
  elements.scanButton.disabled = loading;
  elements.paperButton.disabled = loading;
  elements.scanLabel.textContent = loading && mode === "scan" ? "Analysiert …" : "Markt scannen";
  elements.paperLabel.textContent = loading && mode === "paper" ? "Aktualisiert …" : "Paper-Plan ausführen";
  if (loading) showNotice("Analyse läuft. Bei einem größeren Universum kann das etwas dauern.");
}

async function requestJSON(url, options = {}) {
  const response = await fetch(url, options);
  const payload = await response.json().catch(() => ({ error: "Ungültige Serverantwort" }));
  if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
  return payload;
}

function updateGate(id, pass, reason, pending = false) {
  const card = document.querySelector(id);
  card.classList.remove("pass", "block", "pending");
  card.classList.add(pending ? "pending" : pass ? "pass" : "block");
  card.querySelector(".gate-state").textContent = pending ? "WARTET" : pass ? "PASS" : "BLOCK";
  card.querySelector(".gate-reason").textContent = reason;
}

function renderGates(payload) {
  const modelPass = Boolean(payload.diagnostics?.quality_pass);
  const backtestPass = Boolean(payload.backtest?.quality_pass);
  const eligible = (payload.plans || []).filter((plan) => plan.action === "PAPER_BUY");
  updateGate("#model-gate", modelPass, payload.diagnostics?.reason || "Keine Modelldiagnose.");
  updateGate("#backtest-gate", backtestPass, payload.backtest?.reason || "Kein Backtest.");
  const executionPass = modelPass && backtestPass && eligible.length > 0;
  const executionReason = !modelPass || !backtestPass
    ? "Mindestens ein vorgelagertes Qualitäts-Gate blockiert neue Positionen."
    : eligible.length
      ? `${eligible.length} Setup${eligible.length === 1 ? "" : "s"} erfüllen Modell-, Strategie- und Risikoregeln.`
      : "Die Qualitäts-Gates bestehen, aber aktuell erfüllt kein Chart die Strategiebedingungen.";
  updateGate("#execution-gate", executionPass, executionReason);
}

function renderMetrics(payload) {
  const best = payload.plans?.[0];
  setText("#metric-probability", best ? formatPercent(best.probability_up) : "—");
  setText("#metric-symbol", best ? `${best.symbol} · ${labels.strategies[best.strategy] || best.strategy}` : "Keine Daten");
  setText(
    "#metric-brier",
    finite(payload.diagnostics?.brier_score)
      ? `${formatDecimal(payload.diagnostics.brier_score)} / ${formatDecimal(payload.diagnostics.baseline_brier)}`
      : "—",
  );
  const returnNode = document.querySelector("#metric-return");
  returnNode.textContent = formatPercent(payload.backtest?.compounded_return);
  setTone(returnNode, payload.backtest?.compounded_return);
  setText("#metric-trades", `${payload.backtest?.trades || 0} Trades`);
  const drawdownNode = document.querySelector("#metric-drawdown");
  drawdownNode.textContent = formatPercent(payload.backtest?.max_drawdown);
  setTone(drawdownNode, payload.backtest?.max_drawdown);
  setText("#metric-winrate", formatPercent(payload.backtest?.win_rate));
  setText("#metric-equity", formatMoney(payload.portfolio?.equity, payload.currency));
  setText("#metric-positions", `${payload.portfolio?.position_count || 0} Positionen`);

  setText("#risk-per-trade", formatPercent(payload.guardrails?.risk_per_trade, 2));
  setText("#max-exposure", formatPercent(payload.guardrails?.max_portfolio_exposure, 0));
  setText("#max-positions", String(payload.guardrails?.max_positions ?? "—"));
  setText("#probability-threshold", formatPercent(payload.guardrails?.probability_threshold, 0));
}

function appendCell(row, content, className = "") {
  const cell = document.createElement("td");
  if (className) cell.className = className;
  if (content instanceof Node) cell.append(content);
  else cell.textContent = content;
  row.append(cell);
  return cell;
}

function renderPlans() {
  const plans = currentPayload?.plans || [];
  const query = elements.searchInput.value.trim().toUpperCase();
  const action = elements.actionFilter.value;
  const strategy = elements.strategyFilter.value;
  const filtered = plans.filter((plan) => {
    const matchesQuery = !query || plan.symbol.toUpperCase().includes(query) || plan.asset_id.toUpperCase().includes(query);
    const matchesAction = action === "ALL" || (action === "PAPER_BUY" ? plan.action === "PAPER_BUY" : plan.action !== "PAPER_BUY");
    const matchesStrategy = strategy === "ALL" || plan.strategy === strategy;
    return matchesQuery && matchesAction && matchesStrategy;
  });

  elements.planBody.replaceChildren();
  if (!filtered.length) {
    const row = document.createElement("tr");
    row.className = "empty-row";
    const cell = document.createElement("td");
    cell.colSpan = 11;
    cell.textContent = plans.length ? "Kein Asset passt zu den Filtern." : "Noch keine Analyse. Der Marktplan bleibt leer.";
    row.append(cell);
    elements.planBody.append(row);
  }

  for (const plan of filtered) {
    const row = document.createElement("tr");
    row.title = plan.rationale || "";

    const coin = document.createElement("div");
    coin.className = "coin-cell";
    const symbol = document.createElement("strong");
    symbol.textContent = plan.symbol;
    const risk = document.createElement("span");
    risk.textContent = plan.risk_tier;
    coin.append(symbol, risk);
    appendCell(row, coin);

    const regime = document.createElement("span");
    regime.className = "regime-pill";
    regime.textContent = labels.regimes[plan.market_regime] || plan.market_regime;
    appendCell(row, regime);

    const strategyBadge = document.createElement("span");
    strategyBadge.className = `strategy-pill${plan.strategy === "CASH_DEFENSIVE" ? " cash" : ""}`;
    strategyBadge.textContent = labels.strategies[plan.strategy] || plan.strategy;
    appendCell(row, strategyBadge);

    const probability = document.createElement("div");
    const probabilityLabel = document.createElement("span");
    probabilityLabel.textContent = formatPercent(plan.probability_up);
    const track = document.createElement("progress");
    track.className = "probability-track";
    track.max = 1;
    track.value = Math.max(0, Math.min(1, plan.probability_up || 0));
    track.setAttribute("aria-label", `Wahrscheinlichkeit ${formatPercent(plan.probability_up)}`);
    probability.append(probabilityLabel, track);
    appendCell(row, probability, "probability-cell");

    appendCell(row, `${formatPercent(plan.strategy_win_rate)} · n=${plan.strategy_samples}`);
    const expectancy = appendCell(row, formatPercent(plan.strategy_expected_net_return, 2));
    setTone(expectancy, plan.strategy_expected_net_return);

    const actionBadge = document.createElement("span");
    actionBadge.className = `action-pill ${plan.action === "PAPER_BUY" ? "buy" : "blocked"}`;
    actionBadge.textContent = labels.actions[plan.action] || plan.action;
    appendCell(row, actionBadge);

    appendCell(row, formatPrice(plan.price, currentPayload.currency));
    appendCell(row, formatPrice(plan.stop_price, currentPayload.currency));
    appendCell(row, formatPrice(plan.target_price, currentPayload.currency));
    appendCell(row, formatPercent(plan.position_fraction));
    elements.planBody.append(row);
  }
  elements.tableSummary.textContent = `${filtered.length} von ${plans.length} Assets`;
}

function showChart(charts, index) {
  const chart = charts[index];
  elements.chartStage.replaceChildren();
  const image = document.createElement("img");
  image.src = chart.url;
  image.alt = chart.kind === "backtest" ? "Walk-forward Backtest Equity-Kurve" : `${chart.name} Strategie-Chart`;
  image.loading = index === 0 ? "eager" : "lazy";
  elements.chartStage.append(image);
  [...elements.chartTabs.children].forEach((button, buttonIndex) => {
    button.setAttribute("aria-selected", buttonIndex === index ? "true" : "false");
  });
}

function renderCharts(payload) {
  const charts = [...(payload.charts || [])].sort((a, b) => (a.kind === "backtest" ? -1 : b.kind === "backtest" ? 1 : 0));
  elements.chartTabs.replaceChildren();
  elements.chartStage.replaceChildren();
  elements.chartCount.textContent = `${charts.length} Chart${charts.length === 1 ? "" : "s"}`;
  if (!charts.length) {
    const empty = document.createElement("div");
    empty.className = "empty-visual";
    const title = document.createElement("strong");
    title.textContent = "Keine Charts verfügbar";
    const text = document.createElement("p");
    text.textContent = "Die Analyse lieferte keine darstellbaren Kursreihen.";
    empty.append(title, text);
    elements.chartStage.append(empty);
    return;
  }
  charts.forEach((chart, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "chart-tab";
    button.setAttribute("role", "tab");
    button.setAttribute("aria-selected", index === 0 ? "true" : "false");
    button.textContent = chart.kind === "backtest" ? "Walk-forward" : chart.name.replace(" strategy", "");
    button.addEventListener("click", () => showChart(charts, index));
    elements.chartTabs.append(button);
  });
  showChart(charts, 0);
}

function renderPortfolio(payload) {
  const portfolio = payload.portfolio || {};
  const positions = portfolio.positions || [];
  elements.portfolioPositions.replaceChildren();
  if (!positions.length) {
    const empty = document.createElement("div");
    empty.className = "empty-inline";
    empty.textContent = "Keine simulierten Positionen.";
    elements.portfolioPositions.append(empty);
  }
  for (const position of positions) {
    const card = document.createElement("article");
    card.className = "position-card";
    const header = document.createElement("header");
    const symbol = document.createElement("strong");
    symbol.textContent = position.symbol;
    const pnl = document.createElement("span");
    pnl.textContent = formatPercent(position.unrealized_return);
    setTone(pnl, position.unrealized_return);
    header.append(symbol, pnl);
    const rows = [
      ["Wert", formatMoney(position.market_value, payload.currency)],
      ["Entry", formatPrice(position.entry_price, payload.currency)],
      ["Stop / Ziel", `${formatPrice(position.stop_price, payload.currency)} / ${formatPrice(position.target_price, payload.currency)}`],
      ["Strategie", labels.strategies[position.strategy] || position.strategy],
    ];
    card.append(header);
    rows.forEach(([label, value]) => {
      const line = document.createElement("div");
      const left = document.createElement("span");
      left.textContent = label;
      const right = document.createElement("strong");
      right.textContent = value;
      line.append(left, right);
      card.append(line);
    });
    elements.portfolioPositions.append(card);
  }

  elements.portfolioStatus.textContent = payload.mode === "paper" ? "PAPER AKTUALISIERT" : "NUR ANALYSE";
  elements.portfolioStatus.className = `badge ${payload.mode === "paper" ? "paper" : "neutral"}`;

  const activities = [];
  for (const message of portfolio.messages || []) activities.push({ label: "Aktueller Lauf", text: message });
  for (const transaction of [...(portfolio.recent_transactions || [])].reverse()) {
    activities.push({
      label: formatTime(transaction.time),
      text: `${transaction.side} ${transaction.symbol} · ${transaction.quantity} @ ${transaction.price} · ${transaction.reason}`,
    });
  }
  if (!activities.length) activities.push({ label: "System", text: "Analyse abgeschlossen, keine Paper-Transaktion." });
  elements.activityLog.replaceChildren();
  activities.slice(0, 20).forEach((activity) => {
    const item = document.createElement("li");
    const label = document.createElement("span");
    label.textContent = activity.label;
    const text = document.createElement("p");
    text.textContent = activity.text;
    item.append(label, text);
    elements.activityLog.append(item);
  });
}

function render(payload) {
  currentPayload = payload;
  const modeText = payload.demo ? "SYNTHETISCHE DEMO" : "LIVE-MARKTDATEN";
  elements.modeBadge.textContent = modeText;
  elements.sourceLine.textContent = `${payload.source} · Datenstand ${formatTime(payload.data_as_of)} · ${payload.universe_size} Assets`;
  showNotice(
    payload.demo
      ? "Demo-Modus: Alle Kurse sind synthetisch. Ergebnisse sind kein Beleg für reale Performance."
      : "Live-Marktdaten, weiterhin ausschließlich Paper-Trading. Tagesdaten bilden Spreads und Intraday-Ausführungen nur näherungsweise ab.",
  );
  renderGates(payload);
  renderMetrics(payload);
  renderPlans();
  renderCharts(payload);
  renderPortfolio(payload);
  elements.timestampLine.textContent = `Analyse erstellt ${formatTime(payload.generated_at)} · ${payload.source}`;
}

async function runAnalysis(mode) {
  setLoading(true, mode);
  try {
    const payload = await requestJSON("/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode }),
    });
    render(payload);
    showToast(mode === "paper" ? "Paper-Portfolio wurde sicher aktualisiert." : "Marktanalyse abgeschlossen.");
  } catch (error) {
    showNotice(error.message, true);
    showToast(error.message, true);
  } finally {
    setLoading(false, mode);
  }
}

async function initialize() {
  try {
    const health = await requestJSON("/api/health");
    elements.connectionDot.className = "online";
    elements.connectionLabel.textContent = "App verbunden";
    elements.modeBadge.textContent = health.demo ? "SYNTHETISCHE DEMO" : "LIVE-MARKTDATEN";
    const previous = await requestJSON("/api/result");
    if (previous.status === "ready") render(previous);
  } catch (error) {
    elements.connectionDot.className = "offline";
    elements.connectionLabel.textContent = "App nicht erreichbar";
    showNotice(error.message, true);
  }
}

elements.scanButton.addEventListener("click", () => runAnalysis("scan"));
elements.paperButton.addEventListener("click", () => runAnalysis("paper"));
elements.searchInput.addEventListener("input", renderPlans);
elements.actionFilter.addEventListener("change", renderPlans);
elements.strategyFilter.addEventListener("change", renderPlans);

initialize();
