"""End-to-end API risk/ledger test with explicitly synthetic test fixtures."""
import time
from collections import deque
from fastapi.testclient import TestClient
from axiom_intel.api import create_app
from axiom_intel.config import Settings
from conftest import TOKEN, trade, market, security


def test_api_signal_manual_paper_order_idempotency_close_and_kill():
    app=create_app(Settings(mode='offline',database_url='sqlite+aiosqlite:///:memory:'))
    with TestClient(app) as client:
        engine=app.state.engine
        now=time.time()
        async def seed_test_evidence():
            engine.status['connected']=True
            engine.status['last_gap']=now-120
            for status in engine.status['venues'].values():status['last_gap']=now-120
            engine.observed_since[TOKEN]=now-120
            engine.markets[TOKEN]=market(now)
            engine.security[TOKEN]=security(now)
            rows=[trade(i,at=now-59+i,usd=50,price=.93) for i in range(20)]
            rows += [trade(100+i,at=now-29+i,usd=300,price=1) for i in range(29)]
            for e in rows:e.quote_price_at=now-1
            engine.events[TOKEN]=deque(rows)
        client.portal.call(seed_test_evidence)
        request={'token':TOKEN,'notional_usd':100,'idempotency_key':'full-flow-order'}
        first=client.post('/api/paper/buy',json=request)
        assert first.status_code==200,first.text
        assert first.json()['mode']=='paper'
        assert client.post('/api/paper/buy',json=request).json()==first.json()
        snapshot=client.get('/api/snapshot').json()
        assert len(snapshot['portfolio']['positions'])==1
        client.post('/api/risk/kill?active=true')
        closed=client.post('/api/paper/'+TOKEN+'/close',json={'fraction':1,'idempotency_key':'full-flow-close'})
        assert closed.status_code==200,closed.text
        assert closed.json()['realized_pnl_usd']<0
        assert client.post('/api/paper/buy',json={**request,'idempotency_key':'blocked-by-kill'}).status_code==409
        final=client.get('/api/snapshot').json()
        assert not final['portfolio']['positions'] and len(final['portfolio']['journal'])==2
