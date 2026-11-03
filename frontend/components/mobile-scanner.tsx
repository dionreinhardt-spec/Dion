"use client";
import { useState } from "react";
import { ArrowUpRight, ChevronRight, Clock3 } from "lucide-react";
import type { Token } from "../app/types";
const usd = (n: number | null | undefined) =>
  n == null
    ? "—"
    : new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
        notation: "compact",
        maximumFractionDigits: 1,
      }).format(n);
export function MobileScanner({
  tokens,
  windowKey,
  selected,
  onSelect,
}: {
  tokens: Token[];
  windowKey: string;
  selected?: string;
  onSelect(token: string): void;
}) {
  const [visible, setVisible] = useState(30);
  return (
    <div className="mobile-scanner" aria-label="Token-Karten">
      {tokens.slice(0, visible).map((coin) => {
        const flow = coin.windows[windowKey];
        return (
          <button
            type="button"
            key={coin.token}
            className={
              "coin-card " + (selected === coin.token ? "selected" : "")
            }
            onClick={() => onSelect(coin.token)}
            aria-label={coin.symbol + " analysieren"}
          >
            <div className="coin-card-head">
              <span className="token-icon">
                {coin.symbol.slice(0, 2).toUpperCase()}
              </span>
              <span className="coin-card-name">
                <b>{coin.symbol}</b>
                <small>
                  SOL · {coin.token.slice(0, 5)}…{coin.token.slice(-4)}
                </small>
              </span>
              <span
                className={
                  "coin-card-score " + (coin.score >= 62 ? "mint" : "")
                }
              >
                {coin.score.toFixed(0)}
                <small>/100</small>
              </span>
              <ChevronRight size={17} />
            </div>
            <dl className="coin-card-metrics">
              <div>
                <dt>Market Cap</dt>
                <dd>{usd(coin.market?.market_cap)}</dd>
              </div>
              <div>
                <dt>Liquidität</dt>
                <dd>{usd(coin.market?.liquidity_usd)}</dd>
              </div>
              <div>
                <dt>
                  Nettofluss ·{" "}
                  {Number(windowKey) < 60
                    ? windowKey + "s"
                    : Number(windowKey) < 3600
                      ? Number(windowKey) / 60 + "m"
                      : Number(windowKey) / 3600 + "h"}
                </dt>
                <dd className={(flow.net_flow_usd || 0) < 0 ? "red" : "mint"}>
                  {flow.net_flow_usd != null && flow.net_flow_usd > 0
                    ? "+"
                    : ""}
                  {usd(flow.net_flow_usd)}
                </dd>
              </div>
              <div>
                <dt>Käufer / Verkäufer</dt>
                <dd>
                  {flow.unique_buyers} <span>/ {flow.unique_sellers}</span>
                </dd>
              </div>
            </dl>
            <div className="coin-card-foot">
              <span
                className={
                  "badge " +
                  (coin.status === "ENTRY_CANDIDATE"
                    ? "good"
                    : coin.status === "BLOCKED"
                      ? "warn"
                      : "neutral")
                }
              >
                {coin.status === "ENTRY_CANDIDATE"
                  ? "ENTRY-KANDIDAT"
                  : coin.status === "BLOCKED"
                    ? "GESPERRT"
                    : "BEOBACHTEN"}
              </span>
              <span className="coin-card-age">
                <Clock3 size={11} />
                {coin.trade_age_s == null
                  ? "Keine Trades"
                  : coin.trade_age_s.toFixed(1) + "s"}
              </span>
              <span className="coin-card-open">
                Analyse <ArrowUpRight size={12} />
              </span>
            </div>
          </button>
        );
      })}
      {tokens.length > visible && (
        <button
          className="load-more small-btn"
          onClick={() => setVisible((n) => n + 30)}
        >
          Weitere {Math.min(30, tokens.length - visible)} Tokens anzeigen
        </button>
      )}
    </div>
  );
}
