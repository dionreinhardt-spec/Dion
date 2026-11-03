import asyncio
import base64
import json
import random
import time
from collections import OrderedDict
import websockets
from .borsh import AnchorSchema, program_events
from ..models import PUMP, PUMP_AMM, WSOL, USDC, Trade
from ..providers import ProviderError


class SolanaAdapter:
    def __init__(self, settings, providers, queue, status, pool_queue=None):
        self.settings, self.providers, self.queue, self.status = settings, providers, queue, status
        self.schemas = {PUMP: AnchorSchema("pump", allow_unknown_tail=True), PUMP_AMM: AnchorSchema("pump_amm", allow_unknown_tail=True)}
        self.pool_cache: OrderedDict[str, dict] = OrderedDict()
        self.pool_locks: dict[str, asyncio.Lock] = {}
        self.subscription_ids: set[int] = set()
        self.subscription_programs = {}
        self.pool_queue = pool_queue or queue
        self.seen: OrderedDict[str, None] = OrderedDict()

    async def run(self):
        programs = [PUMP] + ([PUMP_AMM] if self.settings.watch_pumpswap else [])
        attempt = 0
        while True:
            try:
                async with websockets.connect(self.settings.solana_rpc_ws.get_secret_value(),
                                               ping_interval=20, ping_timeout=20, max_queue=2048,
                                               open_timeout=20, max_size=4_000_000) as ws:
                    self.status.update(connected=False, subscriptions=0, last_gap=time.time())
                    self.subscription_ids.clear()
                    self.subscription_programs.clear()
                    for venue in self.status.get("venues", {}).values():
                        venue["last_gap"] = time.time()
                    for i, p in enumerate(programs, 1):
                        await ws.send(json.dumps({"jsonrpc": "2.0", "id": i, "method": "logsSubscribe",
                                                  "params": [{"mentions": [p]}, {"commitment": "confirmed"}]}))
                    async for message in ws:
                        data = json.loads(message)
                        now = time.time()
                        self.status["last_message_at"] = now
                        if "error" in data:
                            raise ProviderError("Solana subscription rejected")
                        if "result" in data and "id" in data:
                            self.subscription_ids.add(data["result"])
                            self.subscription_programs[data["result"]] = programs[int(data["id"]) - 1]
                            self.status["subscriptions"] = len(self.subscription_ids)
                            self.status["connected"] = len(self.subscription_ids) == len(programs)
                            attempt = 0
                            continue
                        result = data.get("params", {}).get("result", {})
                        value = result.get("value", {})
                        if value.get("err") is not None or not value.get("signature"):
                            continue
                        sig = value["signature"]
                        program = self.subscription_programs.get(data.get("params", {}).get("subscription"))
                        if not program:
                            continue
                        dedup_key = sig + program
                        if dedup_key in self.seen:
                            continue
                        self.seen[dedup_key] = None
                        if len(self.seen) > 30000:
                            self.seen.popitem(last=False)
                        job = {"signature": sig, "logs": value.get("logs", []), "slot": result["context"]["slot"],
                               "received_at": now, "program": program}
                        target = self.queue if program == PUMP else self.pool_queue
                        venue = "pump" if program == PUMP else "pumpswap"
                        try:
                            target.put_nowait(job)
                        except asyncio.QueueFull:
                            self.status["dropped"] += 1
                            self.status["venues"][venue]["last_gap"] = now
                            self.status["venues"][venue]["dropped"] += 1
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                # Never stringify exceptions carrying authenticated provider URLs.
                self.status.update(connected=False, last_gap=time.time(), last_error=type(exc).__name__)
                self.status["reconnects"] += 1
                await asyncio.sleep(min(30, 2**min(attempt, 5)) + random.random())
                attempt += 1

    async def pool(self, address: str) -> dict:
        if address in self.pool_cache:
            self.pool_cache.move_to_end(address)
            return self.pool_cache[address]
        lock = self.pool_locks.setdefault(address, asyncio.Lock())
        try:
            async with lock:
                if address in self.pool_cache:
                    return self.pool_cache[address]
                r = await self.providers.rpc("getAccountInfo", [address, {"encoding": "base64", "commitment": "confirmed"}])
                value = r.get("value")
                if not value or value.get("owner") != PUMP_AMM:
                    raise ProviderError("Unverified PumpSwap pool owner")
                p = self.schemas[PUMP_AMM].account("Pool", base64.b64decode(value["data"][0]))
                self.pool_cache[address] = p
                if len(self.pool_cache) > self.settings.max_candidates * 4:
                    self.pool_cache.popitem(last=False)
                return p
        finally:
            if not lock.locked():
                self.pool_locks.pop(address, None)

    async def decode(self, job: dict):
        for index, program, name, event in program_events(job["logs"], self.schemas):
            if job.get("program") and program != job["program"]:
                continue
            now = job["received_at"]
            stamp = event.get("timestamp")
            if not stamp or abs(stamp - now) > 120:
                self.status["rejected_time"] += 1
                continue
            base = {"id": f"solana:{job['signature']}:{index}", "timestamp": float(stamp),
                    "received_at": now, "slot": job["slot"], "signature": job["signature"], "event_index": index}
            if name in ("CreateEvent", "CompletePumpAmmMigrationEvent", "CreatePoolEvent", "CompleteEvent"):
                yield "lifecycle", {**base, "event": name, "program": program, "data": event}
            if program == PUMP and name == "TradeEvent":
                # Current schema explicitly names the quote mint. Never interpret
                # the old 'sol_amount' field as SOL for a non-SOL quote.
                quote = event["quote_mint"]
                # Legacy SOL-only instructions emit the all-zero pubkey as quote
                # in observed mainnet events. Map only those explicit instruction
                # names; never guess a quote for the generic v2/v3 instructions.
                if quote == "11111111111111111111111111111111" and event.get("ix_name") in {"buy", "sell", "buy_exact_sol_in"}:
                    quote = WSOL
                token = event["mint"]
                raw_quote = event["quote_amount"]
                raw_token = event["token_amount"]
                side = "buy" if event["is_buy"] else "sell"
            elif program == PUMP_AMM and name in ("BuyEvent", "SellEvent"):
                pool = await self.pool(event["pool"])
                token, quote = pool["base_mint"], pool["quote_mint"]
                raw_quote = event["quote_amount_in"] if name == "BuyEvent" else event["quote_amount_out"]
                raw_token = event["base_amount_out"] if name == "BuyEvent" else event["base_amount_in"]
                side = "buy" if name == "BuyEvent" else "sell"
                yield "vault", {"token": token, "owner": event["pool"]}
            else:
                continue
            if quote not in (WSOL, USDC) or raw_quote <= 0 or raw_token <= 0:
                self.status["unsupported_quote"] += 1
                continue
            usd, price_at = self.providers.quote(quote, now)
            trade = Trade(**base, token=token, venue="pump" if program == PUMP else "pumpswap", wallet=event["user"],
                          side=side, token_amount_raw=raw_token, quote_amount_raw=raw_quote, quote_mint=quote,
                          quote_decimals=9 if quote == WSOL else 6, quote_usd=usd, quote_price_at=price_at,
                          schema_warning=(f"Ungeprüfter IDL-Anhang: {event['_unverified_tail_bytes']} Bytes" if event.get("_unverified_tail_bytes") else None))
            yield "trade", trade
