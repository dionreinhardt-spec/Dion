import {
  Crosshair,
  Globe2,
  Layers,
  Menu,
  Radar,
  X,
  Wallet,
  Flame,
  TrendingUp,
  SquareTerminal,
  Settings2,
  Download,
  ChevronRight,
} from "lucide-react";
const tabs = [
  { id: "scanner", label: "Scanner", icon: Radar },
  { id: "opportunities", label: "Setups", icon: Crosshair },
  { id: "positions", label: "Positionen", icon: Layers },
  { id: "social", label: "Social", icon: Globe2 },
];
const extra = [
  { id: "wallets", label: "Wallet-Intelligenz", icon: Wallet },
  { id: "launches", label: "Neue Launches", icon: Flame },
  { id: "performance", label: "Paper-Journal", icon: TrendingUp },
  { id: "system", label: "Quellen & System", icon: SquareTerminal },
];
export function MobileNavigation({
  tab,
  navigate,
  more,
  setMore,
  setups,
  openSettings,
}: {
  tab: string;
  navigate(tab: string): void;
  more: boolean;
  setMore(value: boolean): void;
  setups: number;
  openSettings(): void;
}) {
  return (
    <>
      <nav className="mobile-nav" aria-label="iPhone-Navigation">
        {tabs.map((item) => (
          <button
            key={item.id}
            onClick={() => navigate(item.id)}
            aria-current={tab === item.id ? "page" : undefined}
            className={tab === item.id ? "active" : ""}
          >
            <item.icon size={21} />
            <span>{item.label}</span>
            {item.id === "opportunities" && setups > 0 ? (
              <em>{setups}</em>
            ) : null}
          </button>
        ))}
        <button
          onClick={() => setMore(!more)}
          className={
            more || extra.some((item) => item.id === tab) ? "active" : ""
          }
          aria-label="Weitere Bereiche"
          aria-expanded={more}
        >
          <Menu size={21} />
          <span>Mehr</span>
        </button>
      </nav>
      {more && (
        <div
          className="modal-backdrop mobile-more-backdrop"
          onClick={() => setMore(false)}
        >
          <section
            className="modal mobile-more"
            role="dialog"
            aria-modal="true"
            aria-labelledby="more-title"
            onClick={(e) => e.stopPropagation()}
          >
            <span className="sheet-grip" />
            <div className="mobile-sheet-heading">
              <div>
                <span className="eyebrow">DEIN TERMINAL</span>
                <h2 id="more-title">Mehr entdecken</h2>
              </div>
              <button
                className="icon-btn"
                onClick={() => setMore(false)}
                aria-label="Menü schließen"
              >
                <X size={21} />
              </button>
            </div>
            <div className="mobile-menu-items">
              {extra.map((item) => (
                <button key={item.id} onClick={() => navigate(item.id)}>
                  <item.icon size={20} />
                  <span>{item.label}</span>
                  <ChevronRight size={16} />
                </button>
              ))}
              <button onClick={openSettings}>
                <Settings2 size={20} />
                <span>Verbindung & API</span>
                <ChevronRight size={16} />
              </button>
              <a href="/install">
                <Download size={20} />
                <span>Zum Home-Bildschirm hinzufügen</span>
                <ChevronRight size={16} />
              </a>
            </div>
            <p className="mobile-menu-note">
              Der Scanner läuft auf deinem Server.
              <br />
              Paper Trading · Keine Live-Orders
            </p>
          </section>
        </div>
      )}
    </>
  );
}
