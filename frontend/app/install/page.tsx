import Link from "next/link";
import {
  ArrowLeft,
  Share,
  PlusSquare,
  ShieldCheck,
  Server,
  Smartphone,
} from "lucide-react";
export default function InstallPage() {
  return (
    <main className="install-page">
      <Link className="install-back" href="/">
        <ArrowLeft size={18} /> Zum Terminal
      </Link>
      <div className="install-hero">
        <img src="/icons/apple-touch-icon.png" alt="" width="88" height="88" />
        <span className="eyebrow">AXIOM INTELLIGENCE · IPHONE</span>
        <h1>
          Dein Markt.
          <br />
          In deiner Hand.
        </h1>
        <p>
          Installiere dein persönliches Terminal auf dem Home-Bildschirm. Die
          Analyse läuft auf deinem Rechner oder VPS.
        </p>
      </div>
      <section className="install-steps">
        <h2>In Safari hinzufügen</h2>
        <ol>
          <li>
            <span>1</span>
            <div>
              <b>Deine HTTPS-Adresse öffnen</b>
              <p>
                Öffne die bereitgestellte Adresse deines Backends in Safari.
                localhost auf dem iPhone führt zum iPhone selbst.
              </p>
            </div>
          </li>
          <li>
            <span>
              <Share size={18} />
            </span>
            <div>
              <b>Teilen öffnen</b>
              <p>
                Im Seitenmenü auf „Teilen“ tippen; je nach Safari-Layout ist die
                Teilen-Taste direkt in der Leiste.
              </p>
            </div>
          </li>
          <li>
            <span>
              <PlusSquare size={18} />
            </span>
            <div>
              <b>Zum Home-Bildschirm</b>
              <p>
                „Zum Home-Bildschirm“ wählen, gegebenenfalls „Als Web-App
                öffnen“ einschalten und „Hinzufügen“ tippen.
              </p>
            </div>
          </li>
          <li>
            <span>
              <Smartphone size={18} />
            </span>
            <div>
              <b>Öffnen und verbinden</b>
              <p>
                Das neue Symbol antippen. Unter „Verbindung & API“ den eigenen
                API-Token eingeben. Er bleibt nur im Arbeitsspeicher dieser
                Sitzung.
              </p>
            </div>
          </li>
        </ol>
      </section>
      <section className="install-facts">
        <p>
          <Server size={19} />
          <span>
            24/7-Analyse benötigt einen laufenden Server. iOS kann eine
            geschlossene oder gesperrte Web-App pausieren.
          </span>
        </p>
        <p>
          <ShieldCheck size={19} />
          <span>
            Paper Trading bleibt aktiv. Nach Standby werden frische Daten
            angefordert. Keine App-Store-App, keine iPhone-Hintergrundgarantie
            und keine Web-Push-Integration.
          </span>
        </p>
      </section>
      <Link className="primary-btn" href="/">
        Terminal öffnen
      </Link>
    </main>
  );
}
