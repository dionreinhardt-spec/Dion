"""Read-only Robinhood adapter. Logs are raw evidence, never decoded trading signals.

No DEX deployment was independently verified during this MVP. Only configured
allowlisted contracts can be subscribed. A sequencer feed is NOT eth_subscribe.
"""
import asyncio
import json
import random
import time
import re
import websockets


class RobinhoodAdapter:
    def __init__(self, settings, providers, store, status):
        self.settings, self.providers, self.store, self.status = settings, providers, store, status

    async def run(self):
        s = self.settings
        addresses = [a.strip().lower() for a in s.robinhood_contracts.split(",") if a.strip()]
        if not addresses:
            self.status.update(state="blocked-no-verified-dex-contracts", connected=False)
            return
        if any(not re.fullmatch(r"0x[0-9a-f]{40}", a) for a in addresses):
            self.status.update(state="invalid-contract-allowlist", connected=False)
            return
        while True:
            try:
                chain_id = int(await self.providers.evm("eth_chainId", []), 16)
                if chain_id != s.robinhood_chain_id:
                    self.status.update(state="wrong-chain-id", actual_chain_id=chain_id, connected=False)
                    return
                cursor = await self.store.get("robinhood-cursor", {})
                head = int(await self.providers.evm("eth_blockNumber", []), 16)
                start = int(cursor.get("block", s.robinhood_start_block if s.robinhood_start_block is not None else head))
                async with websockets.connect(s.robinhood_rpc_ws.get_secret_value(), ping_interval=20, ping_timeout=20) as ws:
                    await ws.send(json.dumps({"jsonrpc": "2.0", "id": 1, "method": "eth_chainId", "params": []}))
                    check = json.loads(await ws.recv())
                    if int(check.get("result", "0x0"), 16) != chain_id:
                        raise ValueError("WebSocket chain ID mismatch")
                    await ws.send(json.dumps({"jsonrpc": "2.0", "id": 2, "method": "eth_subscribe",
                                              "params": ["logs", {"address": addresses}]}))
                    ack = json.loads(await ws.recv())
                    if ack.get("error") or not ack.get("result"):
                        raise ValueError("eth_subscribe rejected")
                    self.status.update(state="raw-logs-only", connected=True, chain_id=chain_id, trading_enabled=False)
                    # Overlap replay is idempotent. Removed logs create explicit tombstones.
                    # Bounded catch-up refuses to silently skip a large historical gap.
                    if head - start > 20000:
                        self.status.update(state="backfill-too-large", connected=False)
                        return
                    for low in range(max(0, start - 20), head + 1, 500):
                        logs = await self.providers.evm("eth_getLogs", [{"address": addresses, "fromBlock": hex(low),
                                                                         "toBlock": hex(min(head, low + 499))}])
                        for row in logs:
                            await self.save(row)
                        await self.store.set("robinhood-cursor", {"block": min(head, low + 499)})
                    async for message in ws:
                        data = json.loads(message)
                        if data.get("error"):
                            raise ValueError("RPC subscription failure")
                        row = data.get("params", {}).get("result")
                        if row:
                            await self.save(row)
                            self.status["last_event_at"] = time.time()
                            # Keep a replay overlap for reorgs on restart.
                            await self.store.set("robinhood-cursor", {"block": int(row["blockNumber"], 16)})
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                self.status.update(connected=False, state="reconnecting", last_error=type(exc).__name__)
                await asyncio.sleep(5 + random.random() * 5)

    async def save(self, row: dict):
        key = f"evm:{self.settings.robinhood_chain_id}:{row['blockHash']}:{row['transactionHash']}:{row['logIndex']}"
        if row.get("removed"):
            key += ":removed"
        await self.store.insert_event("evm-raw", row["address"], time.time(), {"id": key, "log": row,
                                                                           "received_at": time.time(), "decoded": False})
