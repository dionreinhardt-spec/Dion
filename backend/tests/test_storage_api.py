import pytest
from fastapi.testclient import TestClient
from axiom_intel.api import create_app
from axiom_intel.config import Settings
from axiom_intel.social import contracts_in
from conftest import trade, TOKEN

async def test_duplicate_durable_event_and_replay_order(store):
    e=trade()
    assert await store.insert_event('trade',TOKEN,e.timestamp,e.model_dump())
    assert not await store.insert_event('trade',TOKEN,e.timestamp,e.model_dump())
    rows=await store.load_events(e.timestamp-1)
    assert len(rows)==1


def test_http_and_websocket_authentication():
    app=create_app(Settings(mode='offline',database_url='sqlite+aiosqlite:///:memory:',api_token='test-token'))
    with TestClient(app) as client:
        assert client.get('/health/live').status_code==200
        assert client.get('/api/snapshot').status_code==401
        assert client.get('/api/snapshot',headers={'Authorization':'Bearer test-token'}).status_code==200
        assert client.post('/api/risk/kill',headers={'Authorization':'Bearer test-token','Origin':'https://evil.test'}).status_code==403
        with client.websocket_connect('/ws') as ws:
            ws.send_json({'token':'test-token'})
            assert ws.receive_json()['execution_mode']=='paper-only'


def test_watchlist_validation_and_live_order_absence():
    app=create_app(Settings(mode='offline',database_url='sqlite+aiosqlite:///:memory:'))
    with TestClient(app) as client:
        assert client.post('/api/watch',json={'token':'$CAT'}).status_code==422
        assert client.post('/api/watch',json={'token':TOKEN}).status_code==200
        assert client.post('/api/live/buy',json={}).status_code==404
        assert client.get('/health/ready').status_code==200


def test_social_exact_contract_no_ticker_or_substring():
    assert contracts_in('Buy $TEST now')==[]
    assert contracts_in('contract: '+TOKEN)==[TOKEN]
    assert contracts_in(TOKEN+'invalid')==[]

async def test_database_collector_lock(tmp_path):
    from axiom_intel.storage import Store
    url='sqlite+aiosqlite:///'+str(tmp_path/'lock.db')
    first,second=Store(url),Store(url)
    await first.start()
    try:
        with pytest.raises(RuntimeError):await second.start()
    finally:
        await first.close();await second.close()

async def test_evm_reorg_tombstone_preserves_raw_evidence(settings,store):
    from axiom_intel.adapters.evm import RobinhoodAdapter
    adapter=RobinhoodAdapter(settings,None,store,{})
    row={'address':'0x'+'1'*40,'blockHash':'0xabc','transactionHash':'0xdef','logIndex':'0x0','blockNumber':'0x10','removed':False}
    await adapter.save(row);await adapter.save(row)
    await adapter.save({**row,'removed':True})
    assert len(await store.load_events(0,'evm-raw'))==2

async def test_slow_event_insert_cannot_resurrect_evicted_candidate(settings,monkeypatch):
    from axiom_intel.engine import Engine
    engine=Engine(settings)
    e=trade()
    async def evict_then_commit(*args):
        engine.events.pop(e.token,None)
        return True
    monkeypatch.setattr(engine.store,'insert_event',evict_then_commit)
    await engine.ingest_trade(e)
    assert e.token not in engine.events
    await engine.providers.close();await engine.store.close()
