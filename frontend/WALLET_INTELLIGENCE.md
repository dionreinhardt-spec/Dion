# KOL-Wallets und Insider-Radar

Diese Erweiterung läuft im bestehenden Node-Frontend. Sie verändert keine Orderfreigabe, keinen Score und keine Paper-Position im Scanner-Backend. Backend und Paper-Journal müssen dafür nicht neu gestartet werden.

## Was tatsächlich geprüft wird

Acht öffentliche Wallet-Adressen sind mit Quellen hinterlegt: drei von Solana Tracker Cupsey zugeordnete Adressen sowie je eine Cented-, Ansem-, Gake-, Euris- und West-Adresse. Die Zuordnungen wurden am 25.11.2026 über die offizielle Solana-Tracker-Anbindung geprüft. Sie sind Anbieter-Angaben, keine signierten Eigentumsnachweise. Es werden weder vollständige Wallet-Sets noch dauerhafte Eigentümer-Zuordnungen behauptet. Kimchi wird ohne belegte Adresse nicht hinzugefügt. `lib/wallet-registry.ts` enthält jede vollständige Adresse, den Quellenlink und das Prüfdatum.

Der Server liest bestätigte SPL-Token- und Token-2022-Konten über `getTokenAccountsByOwner`. Mehrere Token-Konten derselben Wallet werden mit BigInt exakt summiert. Ein erfolgreicher leerer Snapshot entfernt frühere Bestände. Fehlgeschlagene oder ältere Antworten ersetzen sie nicht durch Null und verändern nicht ihren alten Prüfzeitpunkt. Positive Markierungen erlöschen spätestens nach zehn Minuten ohne frische Bestandsdaten. Unvollständige Prüfungen sind sichtbar.

**Bestand ist kein Kaufnachweis.** Geschenkte, gefrorene oder durch Spam verteilte Tokens können in einer Wallet liegen. Ein Kauf, Einstandspreis, eine persönliche Investmententscheidung oder zukünftige Rendite wird daraus nicht abgeleitet. Standardmäßig werden nur Bestände mit einer aktuellen öffentlichen Bewertung ab 25 USD pro Wallet markiert. Restbestände bleiben ausgeblendet; unbewertete Bestände können im KOL-Bereich separat eingeblendet werden. Mehrere Cupsey-Wallets werden als derselbe Anbietername dargestellt, nicht als mehrere unabhängige Trader.

Für die Kurszuordnung wird die dokumentierte DEX-Screener-Batch-API mit höchstens 30 Contracts pro Anfrage verwendet. Nur exakte Solana-Base-Mint-Zuordnungen sind zulässig. Ein Ticker, eine ähnliche Bezeichnung oder ein passender Quote-Token ist kein Ersatz. Unter passenden Pools wird der mit der höchsten gemeldeten Liquidität gewählt. Kursdaten werden nach fünf Minuten ohne Aktualisierung nicht weiter zur Bestandsbewertung benutzt; der tatsächliche Upstream-Preiszeitpunkt ist unbekannt. Empfangszeit und Bestands-Prüfzeit stehen getrennt im Dashboard.

## Insider-Radar: transparente Kriterien

Der Radar ist ein Forschungs- und Risikofilter, kein Nachweis von Insiderwissen. Er unterscheidet:

1. **Launch-Signer hält mindestens 5%:** Die empfangene Launch-Signatur wird mit `getTransaction` erneut bestätigt. Transaktionen werden mit der aktuell dokumentierten Option maxSupportedTransactionVersion: 1 als JSON geprüft, einschließlich v1. Nur eine erfolgreiche Mint-Initialisierung exakt dieses Contracts erlaubt eine Zuordnung zum ersten Unterzeichner. Dieser wird als Launch-Signer bezeichnet, nicht ungeprüft als Entwickler oder Eigentümer.
2. **Launch-Funding:** Eine heutige Holder-Wallet mit mindestens 1% des Gesamtangebots erhielt in genau dieser Mint-Initialisierung mindestens 0,01 SOL durch eine explizite System-Transfer-Instruktion vom Launch-Signer. Gebühren oder CreateAccount-Rent zählen nicht. Das belegt eine Übertragung, kein gemeinsames Eigentum.
3. **Verteilungsrisiko:** Bis zu drei nach Wallet zusammengefasste normale Konten halten mindestens 30% des Angebots. Das ist ein Konzentrationshinweis und wird als solcher getrennt von Launch-Bezügen angezeigt.

Standardmäßig werden bis zu drei Wallets aus einer bestätigten Mint-Initialisierung gezielt per Mint-Filter abgefragt. Das prüft die ersten beiden Kriterien ohne eine globale Holder-Abfrage. Die öffentlichen Solana-Mainnet-RPCs deaktivieren getTokenLargestAccounts und antworten dafür dauerhaft mit HTTP 429. Deshalb ist die Top-20-Analyse einschließlich des dritten Kriteriums standardmäßig **nicht aktiviert**. Sie kann mit WALLET_INTEL_FULL_HOLDERS=1 an einer autorisierten RPC eingeschaltet werden, die diese Methode tatsächlich bereitstellt. Dann ist die Basis ein priorisierter Ausschnitt der 20 größten Token-Konten, keine vollständige Holder-Liste. Konten werden nach exaktem Mint und Token-Programm aufgelöst. Off-curve-Adressen werden mit dem offiziellen `@solana/addresses`-Paket ausgeschlossen. Zusätzlich muss eine normale, nicht ausführbare System-Wallet mit leerem Kontodatensatz bestätigt sein. Pool-/Programm-Adressen werden so nicht pauschal als private Insider eingestuft. Custody-/Börsen-Zuordnungen sind dennoch nicht vollständig bekannt.

Widersprüchliches Angebot, falscher Mint, doppelte Konten, unvollständige Besitzerauflösung oder zu weit auseinanderliegende Slots verhindern aktuelle Markierungen. Ausfälle oder mehr als 15 Minuten alte Holder-Prüfungen werden nicht als aktuelle Hinweise angezeigt. Keine Befunde bedeutet bei fehlender Abdeckung ausdrücklich keine Entwarnung. Vollständige Funding-Graphen, Wallet-Cluster über mehrere Transaktionen, historische Entry-/Exit-Analysen und frühere Social-Posts sind in dieser Version nicht erfasst.

## Betrieb und Konfiguration

`/api/intelligence` liefert nur öffentliche Analyseergebnisse, Quellen und Betriebsstatus. Keine Wallet-Schlüssel, API-Schlüssel oder Portfolio-Daten sind enthalten. Es gibt keinen schreibenden Trading-Endpunkt.

Der Docker-Runtime startet den Prozess über die Next.js-Instrumentierung (`WALLET_INTEL_AUTOSTART=1`). Auch der erste API-Aufruf startet ihn idempotent. Er bleibt nach Schließen des iPhones aktiv, solange der bestehende einzelne Node-Container läuft. Ein Prozessneustart verwirft nur diesen öffentlichen Analyse-Cache und beginnt mit deutlich sichtbarer Aufwärmphase; das Scanner-Backend läuft weiter.

- Ein Zyklus alle 15 Sekunden, nur ein Zyklus gleichzeitig.
- Der Mainnet-Genesis-Hash wird vor der ersten Wallet-Abfrage bestätigt. Eine versehentlich konfigurierte Devnet-/Testnet-RPC wird abgewiesen.
- Ziel-Wiederholung je Wallet: frühestens nach fünf Minuten, abhängig von Budget und Ausfällen. Eine Wallet benötigt zwei Programmanfragen. Wallet- und Launch-/Holder-Prüfungen wechseln sich ab; noch nicht geprüfte Wallets werden nicht von wiederholt fälligen alten Wallets verdrängt; erste vollständige Abdeckung braucht mehrere Minuten.
- Bei einer fehlgeschlagenen Launch-/Holder-Prüfung pausiert dieser Analysepfad zusätzlich zwei Minuten, statt laufend neue Tokens gegen dieselbe gestörte Methode anzufragen.
- Gemeinsames Limit: höchstens 24 RPC-Anfragen je 60 Sekunden pro Frontend-Prozess. Timeout, HTTP 429 und JSON-RPC-Fehler werden behandelt. Auch HTTP 200 mit RPC-Fehler ist kein Erfolg. Kein Client kann das Limit durch wiederholte Seitenaufrufe vervielfachen.
- DEX-Screener: höchstens sechs Anfragen pro Minute pro Prozess, Batch-Maximum 30 Contracts. Unindexierte Tokens werden mit verzögerter Wiederholung behandelt.
- Der Browser holt den gemeinsamen Analyse-Stand alle 30 Sekunden, nur sichtbar und online. Das ist kein sekündlicher KOL-Stream. Der vorhandene Scanner behält seine bisherige Aktualisierung.
- Öffentliche Wallet- und Markt-Caches, Wartelisten und Antwortgrößen sind begrenzt. Kein erfundener Ersatz bei einer Provider-Störung.
- Für mehrere Frontend-Replikate sind ein gemeinsamer Redis-Cache und ein zentraler Provider-Limiter erforderlich; aktuell ist eine Replik aktiv.

Optionale serverseitige Variablen stehen in `.env.example`. Standard ist die öffentlich verfügbare Solana-Mainnet-RPC; sie hat keine garantierte Verfügbarkeit. Ohne neue Zahlung oder neuen Dienst funktioniert die Integration, soweit diese Datenquelle antwortet. Eine vorhandene zuverlässigere RPC kann über `WALLET_INTEL_RPC_URL` eingesetzt werden. Zugangsdaten gehören ausschließlich in Server-Variablen. Die ChatGPT-Plugin-Verbindung überträgt keinen API-Schlüssel an die laufende App.

## Validierung

Automatisierte Tests prüfen exakte Bestandsarithmetik, falsche Wallet-/Mint-Zuordnung, doppelte Konten, Staubfilter, abgelaufene Daten, Besitzertypen, erfolgreiche und fehlgeschlagene Launch-Transaktionen, getrennte Risikokriterien, das Löschen verschwundener Bestände, ältere Slots, 429-Cooldown und geteilte RPC-Limits. Produktions-Build und Routenvorrang gegenüber dem bestehenden API-Proxy werden geprüft. Zusätzlich wurde eine echte Cupsey-zugeordnete Wallet gegen beide Tokenprogramme gelesen und reale Bestände mit exakter Marktzuordnung gefunden. Test-Fixtures werden nur in Tests verwendet.

Die bestehende Next.js-Version 16.4.3 meldete beim Build Sicherheitsprobleme. Die Version wurde auf 16.4.6 aktualisiert und im Lockfile festgeschrieben. Native iPhone-Hardwaretests werden nicht behauptet.

## Offizielle Referenzen

- https://docs.solanatracker.io/data-api/pnl-v2/leaderboard/get-kol-leaderboard
- https://docs.solanatracker.io/solana-rpc/http/gettokenaccountsbyowner
- https://docs.solanatracker.io/solana-rpc/http/gettokenlargestaccounts
- https://solana.com/docs/rpc/http/getmultipleaccounts
- https://solana.com/docs/rpc/http/gettransaction
- https://solana.com/docs/references/clusters
- https://docs.dexscreener.com/api/reference
- https://github.com/anza-xyz/kit/tree/main/packages/addresses
- https://nextjs.org/docs/app/guides/instrumentation
