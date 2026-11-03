import asyncio
import pytest
from axiom_intel.paper import PaperBroker, RiskRejected
from axiom_intel.models import PaperRequest
from conftest import NOW, TOKEN, eligible_snap

async def setup(settings,store):
    broker=PaperBroker(settings,store,clock=lambda:NOW)
    await broker.start()
    snap=eligible_snap()
    return broker,snap,{TOKEN:snap}

async def test_roundtrip_loses_realistic_costs(settings,store):
    b,s,snaps=await setup(settings,store)
    opened=await b.open(PaperRequest(token=TOKEN,notional_usd=100,idempotency_key="open-order-1"),s,snaps)
    closed=await b.close(TOKEN,1,"close-order-1",s)
    assert opened["fill_price"]>1 and closed["fill_price"]<1
    assert closed["realized_pnl_usd"] < -3
    assert b.state["cash"] < 10000

async def test_concurrent_duplicate_orders_fill_once(settings,store):
    b,s,snaps=await setup(settings,store)
    req=PaperRequest(token=TOKEN,notional_usd=100,idempotency_key="same-order")
    a,c=await asyncio.gather(b.open(req,s,snaps),b.open(req,s,snaps))
    assert a==c and len(b.state["journal"])==1
    with pytest.raises(RiskRejected):
        await b.open(req.model_copy(update={"notional_usd":50}),s,snaps)

async def test_oversize_and_kill_block(settings,store):
    b,s,snaps=await setup(settings,store)
    with pytest.raises(RiskRejected):
        await b.open(PaperRequest(token=TOKEN,notional_usd=1000,idempotency_key="large-order"),s,snaps)
    await b.set_kill(True)
    with pytest.raises(RiskRejected):
        await b.open(PaperRequest(token=TOKEN,notional_usd=100,idempotency_key="killed-order"),s,snaps)
    assert not b.state["journal"]

async def test_stale_exit_never_fabricates_fill(settings,store):
    b,s,snaps=await setup(settings,store)
    await b.open(PaperRequest(token=TOKEN,notional_usd=100,idempotency_key="open-order"),s,snaps)
    stale={**s,"trade_age_s":100}
    with pytest.raises(RiskRejected):
        await b.close(TOKEN,1,"stale-exit",stale)
    assert TOKEN in b.state["positions"]

async def test_restart_preserves_position_kill_and_idempotency(settings,store):
    b,s,snaps=await setup(settings,store)
    req=PaperRequest(token=TOKEN,notional_usd=100,idempotency_key="restart-order")
    fill=await b.open(req,s,snaps)
    await b.set_kill(True)
    b2=PaperBroker(settings,store,clock=lambda:NOW);await b2.start()
    assert b2.state["kill_switch"] and TOKEN in b2.state["positions"]
    assert await b2.open(req,s,snaps)==fill

async def test_partial_exits_allocate_cost_basis(settings,store):
    b,s,snaps=await setup(settings,store)
    await b.open(PaperRequest(token=TOKEN,notional_usd=100,idempotency_key="partial-open"),s,snaps)
    initial=b.state["positions"][TOKEN]["cost_basis"]
    await b.close(TOKEN,.5,"partial-close",s)
    assert b.state["positions"][TOKEN]["cost_basis"]==initial/2

async def test_trailing_stop_closes_at_modeled_market(settings,store):
    b,s,snaps=await setup(settings,store)
    await b.open(PaperRequest(token=TOKEN,notional_usd=100,idempotency_key="stop-open"),s,snaps)
    down={**s,"price_usd":.7};snaps[TOKEN]=down
    await b.tick(snaps,NOW+10)
    assert TOKEN not in b.state["positions"]
    assert b.state["journal"][-1]["fill_price"] < .7

async def test_drawdown_breaker_persists(settings,store):
    b,s,snaps=await setup(settings,store)
    b.state["cash"]=8000
    await b.tick(snaps,NOW)
    assert b.state["breaker"]=="Drawdown-Limit erreicht"
    with pytest.raises(RiskRejected): b.check(snaps)

async def test_database_failure_does_not_ack_fill(settings,store,monkeypatch):
    b,s,snaps=await setup(settings,store)
    async def fail(*a): raise RuntimeError("DB down")
    monkeypatch.setattr(store,"set",fail)
    with pytest.raises(RuntimeError):
        await b.open(PaperRequest(token=TOKEN,notional_usd=100,idempotency_key="db-fail-open"),s,snaps)
    assert not b.state["positions"] and b.state["cash"]==10000

async def test_cached_snapshot_expires_even_if_client_age_unchanged(settings,store):
    b,s,snaps=await setup(settings,store)
    b.clock=lambda:NOW+100
    with pytest.raises(RiskRejected):
        await b.open(PaperRequest(token=TOKEN,notional_usd=100,idempotency_key="expired-cache"),s,snaps)

async def test_injected_execution_never_sends_live_orders():
    from axiom_intel.execution import LiveExecutionDisabled
    with pytest.raises(PermissionError):await LiveExecutionDisabled().execute(None,'auth','key')
