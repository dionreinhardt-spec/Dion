import asyncio
import json
import logging
import math
import time
from collections import Counter, defaultdict, deque
from pathlib import Path
from .adapters.solana import SolanaAdapter
from .adapters.evm import RobinhoodAdapter
from .analytics import analyze, DEFAULT_WEIGHTS
from .config import Settings
from .enrichment import fetch_markets, inspect_mint
from .models import Trade, Market, Security, WSOL, USDC, PUMP
from .paper import PaperBroker
from .providers import Providers
from .social import SocialEngine
from .storage import Store
from .wallets import wallet_metrics

log = logging.getLogger("axiom_intel")


class Engine:
    def __init__(self, settings: Settings):
        self.settings = settings
        settings.prepare_data_dir()
        self.store = Store(settings.database_url.get_secret_value())
        self.providers = Providers(settings)
        self.queue = asyncio.Queue(maxsize=settings.queue_size)
        self.pool_queue = asyncio.Queue(maxsize=settings.queue_size)
        self.status = {"connected": False, "subscriptions": 0, "reconnects": 0, "dropped": 0, "last_gap": time.time(),
                       "last_error": None, "last_message_at": None, "unsupported_quote": 0, "rejected_time": 0,
                       "decode_errors": 0, "candidate_limit_skipped": 0}
        self.status["venues"] = {v: {"dropped": 0, "last_gap": time.time()} for v in ("pump", "pumpswap")}
        self.evm_status = {"state": "disabled", "connected": False}
        self.adapter = SolanaAdapter(settings, self.providers, self.queue, self.status, self.pool_queue)
        self.broker = PaperBroker(settings, self.store)
        self.social = SocialEngine(settings, self.store, self.providers)
        self.events: dict[str, deque] = defaultdict(deque)
        self.markets: dict[str, Market] = {}
        self.security: dict[str, Security] = {}
        self.vaults: dict[str, set[str]] = defaultdict(set)
        self.symbols: dict[str, str] = {}
        self.watchlist: set[str] = set()
        self.observed_since: dict[str, float] = {}
        self.snapshots: dict[str, dict] = {}
        self.launches: deque[dict] = deque(maxlen=100)
        self.counters = Counter()
        self.tasks: list[asyncio.Task] = []
        self.running = False
        self.evaluation_lock = asyncio.Lock()
        self.started_at = time.time()
        self.last_tick = None
        self.last_tick_ms = None
        self.weights = DEFAULT_WEIGHTS.copy()
        self.redis = None
        self.cache_status = "disabled"
        self.alerted: dict[str, float] = {}
        self.errors = deque(maxlen=30)
        self.last_logged = {}
        self.wallet_cache = []
        self.recorded_feed_state = None
        self.last_prune = 0.

    async def start(self):
        await self.store.start()
        await self.broker.start()
        await self.social.start()
        weights_path = Path(self.settings.weights_path)
        if weights_path.exists():
            self.weights = json.loads(weights_path.read_text())
        if set(self.weights) != set(DEFAULT_WEIGHTS) or any(not isinstance(x, (int, float)) or not math.isfinite(x) or x < 0 for x in self.weights.values()) or abs(sum(self.weights.values()) - 100) > 1e-6:
            raise ValueError("Score weights must contain all 12 features and sum to 100")
        profiles = await self.store.get("profiles", {})
        self.watchlist = set(profiles.get("watchlist", []))
        self.markets = {k: Market.model_validate(v) for k, v in profiles.get("markets", {}).items()}
        self.security = {k: Security.model_validate(v) for k, v in profiles.get("security", {}).items()}
        self.vaults.update({k: set(v) for k, v in profiles.get("vaults", {}).items()})
        for raw in await self.store.load_events(time.time() - 86400):
            e = Trade.model_validate(raw)
            if e.token not in self.events and len(self.events) >= self.settings.max_candidates:
                continue
            if e.token in self.security:
                e.decimals = self.security[e.token].decimals
            self.events[e.token].append(e)
        for token in set(self.events) | self.watchlist | set(self.broker.state["positions"]):
            self.observed_since[token] = time.time()
        self.running = True
        self.tasks.append(asyncio.create_task(self.evaluate_loop(), name="evaluation"))
        if self.settings.redis_url:
            from redis.asyncio import Redis
            self.redis = Redis.from_url(self.settings.redis_url.get_secret_value(), decode_responses=True,
                                       socket_connect_timeout=2, socket_timeout=2)
            self.cache_status = "configured"
        if self.settings.mode == "live":
            self.tasks.extend([asyncio.create_task(self.adapter.run(), name="solana-websocket"),
                               asyncio.create_task(self.enrichment_loop(), name="enrichment"),
                               asyncio.create_task(self.security_loop(), name="security"),
                               asyncio.create_task(self.quote_loop(), name="usd-prices"),
                               asyncio.create_task(self.social.run_x(), name="x"),
                               asyncio.create_task(self.social.run_telegram(), name="telegram")])
            self.tasks.extend(asyncio.create_task(self.worker(self.queue), name=f"decode-pump-{i}") for i in range(2))
            if self.settings.watch_pumpswap:
                self.tasks.append(asyncio.create_task(self.worker(self.pool_queue), name="decode-pumpswap"))
            if self.settings.robinhood_enabled:
                self.tasks.append(asyncio.create_task(RobinhoodAdapter(self.settings, self.providers, self.store, self.evm_status).run(), name="robinhood"))
        await self.evaluate()

    def error(self, component, exc):
        from .providers import ProviderError
        entry = {"component": component, "error": type(exc).__name__, "at": time.time()}
        if isinstance(exc, ProviderError):
            entry["detail"] = str(exc)[:160]
        self.errors.append(entry)
        if time.time() - self.last_logged.get(component, 0) > 30:
            log.warning("component_failure component=%s error_type=%s", component, type(exc).__name__)
            self.last_logged[component] = time.time()

    async def stop(self):
        self.running = False
        for task in self.tasks:
            task.cancel()
        await asyncio.gather(*self.tasks, return_exceptions=True)
        await self.persist_profiles()
        if self.redis:
            await self.redis.aclose()
        await self.providers.close()
        await self.store.close()

    async def persist_profiles(self):
        await self.store.set("profiles", {"watchlist": sorted(self.watchlist),
                                          "markets": {k: v.model_dump() for k, v in self.markets.items()},
                                          "security": {k: v.model_dump() for k, v in self.security.items()},
                                          "vaults": {k: sorted(v) for k, v in self.vaults.items()}})

    def select_token(self, token: str) -> bool:
        if token in self.events:
            return True
        if len(self.events) >= self.settings.max_candidates:
            protected = self.watchlist | set(self.broker.state["positions"])
            candidates = [k for k in self.events if k not in protected]
            if not candidates:
                self.status["candidate_limit_skipped"] += 1
                return False
            oldest = min(candidates, key=lambda k: self.events[k][-1].timestamp if self.events[k] else 0)
            if self.events[oldest] and time.time() - self.events[oldest][-1].timestamp < 60:
                self.status["candidate_limit_skipped"] += 1
                return False
            self.events.pop(oldest, None)
            self.snapshots.pop(oldest, None)
            self.markets.pop(oldest, None)
            self.security.pop(oldest, None)
            self.vaults.pop(oldest, None)
            self.observed_since.pop(oldest, None)
            self.symbols.pop(oldest, None)
            self.alerted.pop(oldest, None)
        self.events[token] = deque()
        self.observed_since[token] = time.time()
        return True

    async def ingest_trade(self, event: Trade):
        if not self.select_token(event.token):
            return
        if event.token in self.security:
            event.decimals = self.security[event.token].decimals
        if not await self.store.insert_event("trade", event.token, event.timestamp, event.model_dump()):
            self.counters["duplicates"] += 1
            return
        if event.token not in self.events:
            self.counters["evicted_before_hot_insert"] += 1
            return
        rows = self.events[event.token]
        rows.append(event)
        # Worker completion can reorder events; analytics sorts by chain time.
        retained = [e for e in rows if e.timestamp > time.time() - 86400]
        if len(retained) > self.settings.max_token_events:
            retained = sorted(retained, key=lambda e: e.timestamp)[-self.settings.max_token_events:]
            self.observed_since[event.token] = retained[0].timestamp
            self.counters["hot_retention_truncations"] += 1
        self.events[event.token] = deque(retained)
        self.counters["trades"] += 1
        if event.schema_warning:
            self.counters["schema_warning_events"] += 1

    async def lifecycle(self, event: dict):
        data, name = event["data"], event["event"]
        token = data.get("mint") or data.get("base_mint")
        if not token or not self.select_token(token):
            return
        if not await self.store.insert_event("lifecycle", token, event["timestamp"], event):
            return
        self.launches.appendleft({"token": token, "event": name, "timestamp": event["timestamp"],
                                  "signature": event["signature"], "symbol": data.get("symbol", self.symbols.get(token, token[:6]))})
        if data.get("symbol"):
            self.symbols[token] = data["symbol"][:30]
        vault = data.get("bonding_curve") or data.get("pool")
        if vault:
            self.vaults[token].add(vault)

    async def worker(self, queue):
        while True:
            job = await queue.get()
            try:
                async for kind, event in self.adapter.decode(job):
                    if kind == "trade":
                        await self.ingest_trade(event)
                    elif kind == "lifecycle":
                        await self.lifecycle(event)
                    elif kind == "vault" and self.select_token(event["token"]):
                        self.vaults[event["token"]].add(event["owner"])
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                self.status["decode_errors"] += 1
                venue = "pump" if job.get("program") == PUMP else "pumpswap"
                self.status["venues"][venue]["last_gap"] = time.time()
                self.error("decoder", exc)
            finally:
                queue.task_done()

    def priority_tokens(self):
        protected = self.watchlist | set(self.broker.state["positions"])
        return sorted(set(self.events) | protected, key=lambda k: (k not in protected, -(self.events[k][-1].timestamp if self.events[k] else 0)))

    async def quote_loop(self):
        while True:
            try:
                await self.providers.prices([WSOL, USDC])
            except Exception as exc:
                self.error("usd-prices", exc)
            await asyncio.sleep(15)

    async def enrichment_loop(self):
        cursor = 0
        while True:
            try:
                tokens = self.priority_tokens()
                protected = list(self.watchlist | set(self.broker.state["positions"]))
                batch = list(dict.fromkeys(protected[:15] + tokens[cursor:cursor + 30]))[:30]
                updates = await fetch_markets(self.providers, batch)
                for token, m in updates.items():
                    raw = m.model_dump()
                    raw["id"] = f"market:{token}:{int(m.received_at*1000000)}"
                    await self.store.insert_event("market", token, m.received_at, raw)
                self.markets.update({k: v for k, v in updates.items() if k in self.events})
                cursor = cursor + 30 if cursor + 30 < len(tokens) else 0
                await self.persist_profiles()
            except Exception as exc:
                self.error("dex-enrichment", exc)
            await asyncio.sleep(self.settings.enrichment_interval_s)

    async def security_loop(self):
        while True:
            pending = [t for t in self.priority_tokens() if t not in self.security or time.time() - self.security[t].checked_at > self.settings.security_ttl_s]
            if not pending:
                await asyncio.sleep(2)
                continue
            for token in pending[:10]:
                try:
                    sec = await inspect_mint(self.providers, token, self.vaults[token])
                    raw = sec.model_dump()
                    raw["id"] = f"security:{token}:{int(sec.checked_at*1000000)}"
                    await self.store.insert_event("security", token, sec.received_at or sec.checked_at, raw)
                    if token not in self.events:
                        continue
                    self.security[token] = sec
                    for e in self.events[token]:
                        e.decimals = sec.decimals
                except asyncio.CancelledError:
                    raise
                except Exception as exc:
                    self.error("security", exc)
                await asyncio.sleep(.1)
            await self.persist_profiles()
            await asyncio.sleep(1)

    async def evaluate(self):
        async with self.evaluation_lock:
            await self._evaluate()

    async def _evaluate(self):
        started = time.monotonic()
        now = time.time()
        if now - self.last_prune > 3600:
            await self.store.prune(days=30)
            self.last_prune = now
        total_hot = sum(len(v) for v in self.events.values())
        if total_hot > self.settings.max_hot_events:
            per_token = max(100, self.settings.max_hot_events // max(1, len(self.events)))
            for token, rows in self.events.items():
                if len(rows) > per_token:
                    kept = sorted(rows, key=lambda e: e.timestamp)[-per_token:]
                    self.events[token] = deque(kept)
                    self.observed_since[token] = kept[0].timestamp
            self.counters["hot_retention_truncations"] += 1
        gap = self.status["last_gap"]
        feed_state = (self.status["connected"], gap, tuple((v, d["last_gap"]) for v, d in self.status["venues"].items()))
        if self.settings.mode == "live" and feed_state != self.recorded_feed_state:
            raw = {"id": f"feed:{int(now*1000000)}", "available_at": now, "connected": self.status["connected"], "last_gap": gap, "venues": self.status["venues"]}
            await self.store.insert_event("feed", "", now, raw)
            self.recorded_feed_state = feed_state
        connected = self.status["connected"] and now - gap >= self.settings.min_warmup_s
        for token in self.priority_tokens():
            rows = list(self.events[token])
            token_gap = max([gap] + [self.status["venues"][v]["last_gap"] for v in {e.venue for e in rows if e.timestamp > now - 60}])
            token_connected = self.status["connected"] and now - token_gap >= self.settings.min_warmup_s
            snap = analyze(token, rows, self.markets.get(token), self.security.get(token), self.settings, now,
                           max(self.observed_since.get(token, now), token_gap), token_connected, self.weights,
                           self.social.token_signal(token, now))
            if snap["name"] == "Nicht angereichert" and token in self.symbols:
                snap["symbol"] = self.symbols[token]
            snap["plan"] = self.broker.plan(snap, self.snapshots)
            self.snapshots[token] = snap
            if snap["status"] == "ENTRY_CANDIDATE" and now - self.alerted.get(token, 0) > 120:
                self.alerted[token] = now
                await self.store.insert_event("signal", token, now, {"id": f"signal:{token}:{int(now)}", "snapshot": snap})
                if self.settings.telegram_alerts_enabled:
                    task = asyncio.create_task(self.send_alert(snap), name="telegram-alert")
                    self.tasks.append(task)
        await self.broker.tick(self.snapshots, now)
        if int(now) % 10 == 0:
            self.wallet_cache = wallet_metrics([e for rows in self.events.values() for e in rows], self.settings.modeled_fee_bps)
        if self.redis:
            try:
                await self.redis.set("axiom:latest", json.dumps(self.payload()), ex=5)
                self.cache_status = "connected"
            except Exception as exc:
                self.cache_status = "degraded; in-process fallback"
                self.error("redis", exc)
        self.tasks = [t for t in self.tasks if not (t.get_name() == "telegram-alert" and t.done())]
        self.last_tick, self.last_tick_ms = now, (time.monotonic() - started) * 1000

    async def send_alert(self, snap):
        try:
            await self.social.notify(snap)
        except Exception as exc:
            self.error("telegram-alert", exc)

    async def evaluate_loop(self):
        while True:
            t = time.monotonic()
            try:
                await self.evaluate()
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                self.error("evaluation", exc)
            await asyncio.sleep(max(.01, 1 - (time.monotonic() - t)))

    async def watch(self, token):
        if token not in self.watchlist and len(self.watchlist) >= min(15, self.settings.max_candidates):
            raise ValueError("Watchlist-Limit erreicht")
        if not self.select_token(token):
            raise ValueError("Kandidatenlimit erreicht")
        self.watchlist.add(token)
        await self.persist_profiles()

    def payload(self):
        now = time.time()
        rows = sorted(self.snapshots.values(), key=lambda r: (r["status"] == "ENTRY_CANDIDATE", r["score"]), reverse=True)
        return {"server_time": now, "version": "0.1.0", "mode": self.settings.mode, "execution_mode": "paper-only",
                "scanner": rows, "watchlist": sorted(self.watchlist), "launches": list(self.launches),
                "portfolio": self.broker.portfolio(self.snapshots), "wallets": self.wallet_cache,
                "social": {"status": self.social.status, "trends": self.social.trends(now),
                           "recent": [p.model_dump() for p in self.social.posts[-30:]][::-1]},
                "system": {"solana": self.status, "robinhood": self.evm_status, "queue_depth": self.queue.qsize(),
                           "pool_queue_depth": self.pool_queue.qsize(), "cache": self.cache_status, "counters": dict(self.counters), "last_tick_at": self.last_tick,
                           "evaluation_ms": self.last_tick_ms, "uptime_s": now - self.started_at,
                           "errors": list(self.errors), "target_tick_ms": 1000,
                           "provider_calls": dict(self.providers.calls), "provider_errors": dict(self.providers.errors),
                           "last_provider_success": self.providers.last_success,
                           "costs": {"estimated_rpc_variable_usd": self.providers.calls["rpc"] / 1000 * self.settings.rpc_usd_per_1000,
                                     "configured_fixed_monthly_usd": self.settings.provider_fixed_monthly_usd,
                                     "note": "Schätzung anhand eigener Tarife; keine Provider-Rechnung. X separat budgetiert."}},
                "capabilities": {"solana": "Pump/PumpSwap, SOL-/USDC-Quotes; bestätigte Events, keine Vollabdeckung",
                                 "raydium_meteora": "DEX-Metadaten; native Swap-Decoder noch nicht implementiert",
                                 "smart_money": "FIFO für beobachtete Teilhistorie; kein verifiziertes Smart-Money-Ranking",
                                 "social": "X/Telegram optional; Reddit/Discord noch nicht implementiert",
                                 "narratives": "Lexikalische Baseline; kein trainiertes KI-Modell",
                                 "robinhood": "Optionaler Raw-Log-Adapter; keine verifizierten DEXs/Trading-Signale",
                                 "axiom": "Offizieller Pulse-Link + Contract-Suche; keine Trading-API nachgewiesen",
                                 "live_trading": "Nicht implementiert; kein Freischalt-Schalter"}}
