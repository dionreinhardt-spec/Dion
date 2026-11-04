# Scanner filters and current trends

The scanner now opens on a one-minute window sorted by observed unique buyer wallets. Quick presets: all observed tokens, current trends, positive net inflow, and backend entry candidates. Search, sort and timeframe remain visible; threshold, liquidity, status, full timeframe selection and known volume-anomaly exclusion are under Further Filters.

The default trend preset requires at least 100 different observed buying wallet addresses in one minute. Repeated transactions from one wallet do not increase that unique-wallet count. Wallets are not verified independent people. The scanner ranks only observed candidates, not the entire chain. A partial observation window remains visibly labelled as partial.

Current trend/flow/entry views require a fresh frontend connection and connected backend feed, a token event within the selected activity window and token evaluation at most five seconds old. Entry-candidate views additionally require a token event at most 15 seconds old. Trend counts never override security blocks or paper execution permissions. Known concentrated volume and round-trip activity can be excluded. Positive capital flow additionally requires at least 80% USD-priced trade coverage. Missing values are not replaced with generated numbers.

Thirteen focused tests cover wallet counts versus transaction counts, time windows, thresholds, stale and missing data, anomalous flow, USD coverage, liquidity, sorting, search and preservation of blocked trade permissions. The existing mobile connection and service-worker regression suite remains in place.
