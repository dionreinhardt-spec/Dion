# AI Paper Trader

Ein ehrlicher, probabilistischer Crypto-Marktscanner mit Walk-forward-Backtest und **ausschließlich simulierten Trades**.

Er verspricht weder Fehlerfreiheit noch Gewinn. Sein wichtigstes Verhalten ist das Gegenteil eines Hype-Bots: Wenn Daten, Kalibrierung oder Backtest nicht genügen, lautet das Signal `NO_TRADE_MODEL_GATE`.

## App starten

Nach der Installation öffnet dieser Befehl das zusammenhängende Dashboard im Browser:

```bash
python -m trading_bot app --demo
```

Alternativ starten `sh start_app.sh` (macOS/Linux) oder `start_app.bat` (Windows) direkt den sicheren Demo-Modus.

Die App bündelt Qualitäts-Gates, Modellkennzahlen, den vollständigen Marktplan, Strategie-Charts und das Paper-Portfolio. `Markt scannen` analysiert nur; `Paper-Plan ausführen` darf ausschließlich das lokale simulierte Ledger verändern. Für Live-Marktdaten zuerst `COINGECKO_API_KEY` setzen und `--demo` weglassen:

```bash
python -m trading_bot app --config config.example.yaml
```

Standardmäßig ist die App nur unter `127.0.0.1:8765` erreichbar. Sie hat bewusst kein Login und sollte nicht ungeschützt an eine öffentliche Netzwerkadresse gebunden werden.

## Was der Bot macht

- scannt standardmäßig liquide Top-Coins über eine lesende CoinGecko-Schnittstelle;
- berechnet Momentum, Trend, RSI, Volatilität, Volumen-Ausreißer, Marktbreite und relative Stärke;
- schätzt mit einem regularisierten Ensemble aus linearem Modell und tiefenbegrenztem Random Forest die Wahrscheinlichkeit, dass der Kurs nach dem gewählten Horizont **nach angenommenen Gebühren und Slippage** höher liegt;
- ordnet jeden Chart einem beobachtbaren Marktregime zu und verlangt zusätzlich ein bestätigtes Strategie-Setup;
- validiert ausschließlich zeitlich vorwärts und lässt zwischen Training und Test eine Sperrzone in Länge des Prognosehorizonts;
- vergleicht den Brier-Score mit einer simplen Basisraten-Prognose und blockiert Trades, wenn das Modell keinen Mehrwert zeigt;
- verlangt zusätzlich einen positiven Walk-forward-Backtest nach Kosten, genügend Strategie-Trades und einen begrenzten Drawdown;
- begrenzt Risiko pro Trade, Positionsgröße, Gesamt-Exposure und Zahl der Positionen;
- führt nur ein lokales Paper-Portfolio. Es gibt keine Exchange-Schlüssel und keinen Echtgeld-Endpunkt.
- erzeugt automatisch Kurs-/Volumen-Charts mit SMA 20/50, Bollinger-Bändern sowie Entry-, Stop- und Zielmarken und zusätzlich eine Walk-forward-Equity-Kurve.

## Chart-Strategien

Die Regeln verwenden nur Informationen, die am jeweiligen Analysezeitpunkt bereits sichtbar waren:

| Strategie | Passendes Chartbild | Einstiegsidee | Risikologik |
|---|---|---|---|
| `MOMENTUM_BREAKOUT` | Aufwärtstrend, Ausbruch am oberen Band, bestätigendes Volumen und relative Stärke | Fortsetzung nach bestätigtem Ausbruch | kleinere Position, volatilitätsbasierter Stop, mindestens 2,5R Ziel |
| `TREND_PULLBACK` | SMA-/Trendstruktur positiv, MACD positiv, kontrollierter Rücksetzer statt Überhitzung | Rücksetzer im intakten Trend | normale risikobasierte Position, 2R Ziel |
| `RANGE_MEAN_REVERSION` | kein Abwärtstrend, Kurs deutlich unter dem Mittel, niedriger RSI | Rückkehr zum SMA 20 | kleinere Position, engeres Volatilitätsbudget, ungefähr 1,5R oder SMA 20 |
| `CASH_DEFENSIVE` | Abwärtstrend, extreme Volatilität oder kein eindeutiges Setup | kein Einstieg | Kapital bleibt im Paper-Konto |

Für die aktive Strategie berechnet der Bot eine geglättete historische Trefferquote und eine gegen Ausreißer begrenzte Durchschnittsrendite **nach angenommenen Kosten**. Kleine Stichproben werden mit der gepoolten Strategiehistorie geschrumpft. Ohne genügend Beobachtungen, positive Netto-Erwartung und Mindesttrefferquote entsteht `WATCH_STRATEGY_GATE` statt eines Trades. Diese deskriptive Historie ist kein unabhängiger Test; die eigentliche Qualitätskontrolle erfolgt im zeitlich getrennten Walk-forward-Backtest. Die regelbasierte Chart-Erkennung ist prüfbar und behauptet nicht, klassische Chartmuster könnten die Zukunft sicher vorhersagen.

## Was gute Trader tatsächlich wissen

Sie wissen nicht sicher, was steigt. Sie kombinieren unvollständige Signale:

1. **Preis und Volumen:** Trend, relative Stärke, Volumenbestätigung, Volatilitätsregime.
2. **Liquidität:** Spread, Markttiefe und Slippage. Ein Chart ohne verkaufbare Liquidität ist wertlos.
3. **Positionierung:** Konzentration großer Wallets, Unlocks, Funding und Open Interest – sofern belastbare Daten vorhanden sind.
4. **Katalysatoren:** Listings, Produktnutzung, regulatorische Ereignisse und tatsächliche Einnahmen.
5. **Risikomanagement:** Kleine Verluste überleben; kein einzelner Treffer darf über das Konto entscheiden.

Social Buzz, bezahlte Artikel, Presale-Fortschrittsbalken und angekündigte Listing-Preise sind leicht manipulierbar. Diese Version nutzt sie deshalb nicht als Kursmerkmal.

## Installation

Python 3.11 oder neuer:

```bash
python -m venv .venv
source .venv/bin/activate
pip install -e .
```

Für echte Marktdaten wird ein kostenloser CoinGecko-Demo-API-Key als Umgebungsvariable benötigt. Der Key wird nur im empfohlenen Header übertragen und nicht gespeichert:

```bash
export COINGECKO_API_KEY="dein_demo_key"
```

Die verwendeten Endpunkte entsprechen der offiziellen Dokumentation für [Coins Markets](https://docs.coingecko.com/demo/reference/coins-markets) und [Historical Market Chart](https://docs.coingecko.com/demo/reference/coins-id-market-chart). Ohne Key startet weiterhin `--demo`, echte Scans brechen dagegen mit einer klaren Fehlermeldung ab.

## Sicherer Start mit synthetischen Daten

```bash
python -m trading_bot scan --demo
python -m trading_bot backtest --demo
python -m trading_bot paper --demo --ledger demo_portfolio.json
```

Die PNG-Dateien landen standardmäßig in `charts/`. Mit `--charts-dir anderer_ordner` wird das Ziel geändert; `--no-charts` schaltet die Ausgabe aus.

`--demo` ist eine deterministische Simulation und **kein Beleg** für reale Performance.

## Reale Marktdaten, weiterhin nur Paper-Trading

```bash
cp config.example.yaml config.yaml
python -m trading_bot scan --config config.yaml --json latest_scan.json
python -m trading_bot paper --config config.yaml --ledger paper_portfolio.json
```

Wiederholte Scans:

```bash
python -m trading_bot run --config config.yaml --interval 900 --iterations 8
```

Ein `run` bewegt ebenfalls kein Echtgeld. Bei einem großen Universum begrenzen API-Limits die Aktualität; ein professioneller Vollmarkt-Feed benötigt einen lizenzierten Datenanbieter mit Trades, Orderbüchern, Derivatedaten und On-Chain-Daten.

## Interpretation der Ausgabe

- `PASS`: Die zeitlich getrennten Validierungsprognosen schlagen die Basisrate beim Brier-Score und bleiben ausreichend kalibriert.
- `BLOCK`: Keine neuen simulierten Positionen. Das ist ein Sicherheitsmerkmal, kein Programmfehler.
- `BACKTEST GATE`: blockiert unabhängig vom Modell, wenn nach Kosten weniger als die konfigurierten `minimum_backtest_trades` (standardmäßig 20), keine positive Rendite/Erwartung oder mehr als 25 % Drawdown vorliegen.
- `p(up)`: bedingte Modellschätzung für den konfigurierten Horizont, keine Naturkonstante und keine Garantie.
- `PAPER_BUY`: ausschließlich ein Eintrag ins JSON-Paper-Portfolio.
- `WATCH_PROBABILITY`: die Modellwahrscheinlichkeit reicht nicht.
- `WATCH_NO_SETUP`: der Chart gehört aktuell zu keiner freigegebenen Strategie.
- `WATCH_STRATEGY_GATE`: das Setup existiert, aber seine historische Stichprobe, Trefferquote oder Netto-Erwartung reicht nicht.
- `WATCH_POSITION_LIMIT`: ein valides Setup liegt hinter der konfigurierten Höchstzahl gleichzeitiger Positionen.

Die Terminaltabelle zeigt aus Lesbarkeitsgründen höchstens zehn Coins. Die JSON-Ausgabe enthält den Plan für das gesamte gefilterte Universum; Charts werden für höchstens `max_positions` priorisierte Kandidaten erzeugt.

Die Kennzahlen sind nach pauschalen Gebühren und Slippage berechnet, aber ohne perfekte Nachbildung von Intraday-Pfaden, Spread-Sprüngen, Marktimpact, Delistings oder Steuerfolgen. Besonders bei kleinen Coins unterschätzt ein Tagesdaten-Backtest oft das reale Risiko.

## Tests

```bash
python -m unittest discover -s tests -v
```

Die Tests prüfen unter anderem Look-ahead-Schutz, die zeitliche Sperrzone, das Modell-Gate, Positionslimits und das Paper-Ledger.

## Sinnvolle nächste Ausbaustufe

Für einen ernsthaften Research-Betrieb sollten ergänzend angebunden werden:

- minuten- oder tickbasierte OHLCV- und Orderbuchdaten;
- Derivate-Daten (Funding, Open Interest, Liquidationen);
- verifizierte On-Chain-Verteilung, Unlock-Kalender und Liquiditäts-Locks;
- Datenqualitätsalarme, Drift-Erkennung und tägliche Neukalibrierung;
- getrennte Modelle pro Marktregime und Liquiditätsklasse;
- Shadow-Betrieb über mehrere Monate, bevor überhaupt über Echtgeld nachgedacht wird.

Keine Software kann den gesamten Markt fehlerfrei vorhersagen. Ein belastbarer Trading-Prozess optimiert nicht auf „immer recht haben“, sondern auf überprüfbare Daten, begrenzte Verluste, Kalibrierung und die Fähigkeit, **nicht zu handeln**.
