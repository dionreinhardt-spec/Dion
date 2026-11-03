import { ShieldCheck, Clock3 } from "lucide-react";
import type { Snapshot } from "../app/types";
const usd = (n: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(n);
const price = (n: number) =>
  "$" + n.toLocaleString("en-US", { maximumSignificantDigits: 5 });
export function MobilePositions({
  positions,
  disabled,
  onClose,
}: {
  positions: Snapshot["portfolio"]["positions"];
  disabled: boolean;
  onClose(token: string, fraction: number): void;
}) {
  return (
    <div className="mobile-positions">
      {positions.map((position) => (
        <article className="position-card" key={position.id}>
          <div className="position-card-title">
            <div>
              <b>{position.symbol}</b>
              <small>
                {position.token.slice(0, 6)}…{position.token.slice(-4)}
              </small>
            </div>
            <span className={position.return_pct >= 0 ? "mint" : "red"}>
              {position.return_pct > 0 ? "+" : ""}
              {position.return_pct.toFixed(2)}%
            </span>
          </div>
          <dl className="coin-card-metrics">
            <div>
              <dt>Entry</dt>
              <dd>{price(position.entry_price)}</dd>
            </div>
            <div>
              <dt>Aktuelle Marke</dt>
              <dd>{price(position.mark)}</dd>
            </div>
            <div>
              <dt>Unrealisiertes PnL</dt>
              <dd className={position.unrealized_pnl_usd >= 0 ? "mint" : "red"}>
                {usd(position.unrealized_pnl_usd)}
              </dd>
            </div>
            <div>
              <dt>Stop-Szenario</dt>
              <dd>{price(position.stop_price)}</dd>
            </div>
          </dl>
          <p
            className={
              "position-mark-state " + (position.mark_stale ? "red" : "")
            }
          >
            {position.mark_stale ? (
              <Clock3 size={13} />
            ) : (
              <ShieldCheck size={13} />
            )}{" "}
            {position.mark_stale
              ? "Veraltete Marke · Exit gesperrt"
              : "Paper-Modell · Exit wird neu geprüft"}
          </p>
          <div className="position-card-actions">
            <button
              className="small-btn"
              disabled={disabled || position.mark_stale}
              onClick={() => onClose(position.token, 0.5)}
            >
              50% schließen
            </button>
            <button
              className="small-btn"
              disabled={disabled || position.mark_stale}
              onClick={() => onClose(position.token, 1)}
            >
              Position schließen
            </button>
          </div>
        </article>
      ))}
    </div>
  );
}
