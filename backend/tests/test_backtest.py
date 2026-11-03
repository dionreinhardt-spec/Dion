import pytest
from axiom_intel.backtest import replay
from axiom_intel.performance import performance
from conftest import NOW,trade,market,security

async def test_backtest_rejects_future_data(settings):
    e=trade();e.received_at=NOW+100
    with pytest.raises(ValueError):
        await replay([{'kind':'trade','available_at':NOW,'payload':e.model_dump()}],settings)

async def test_no_feed_evidence_means_no_entry(settings):
    records=[{'kind':'market','available_at':NOW,'payload':market().model_dump()},
             {'kind':'security','available_at':NOW,'payload':security().model_dump()}]
    for i in range(120):
        e=trade(i,at=NOW+i,usd=100)
        records.append({'kind':'trade','available_at':NOW+i,'payload':e.model_dump()})
    result=await replay(records,settings)
    assert not result['journal']


def test_performance_costs_drawdown_and_no_spurious_sharpe():
    report=performance([{'side':'sell','realized_pnl_usd':-10,'fee_usd':1}],[(0,1000),(10,800),(20,900)],1000)
    assert report['max_drawdown_pct']==20
    assert report['net_pnl_usd']==-100
    assert report['daily_sharpe_min_30_days'] is None

async def test_security_result_available_only_after_all_rpc_responses(settings):
    sec=security(NOW);sec.received_at=NOW+8
    with pytest.raises(ValueError):
        await replay([{'kind':'security','available_at':NOW,'payload':sec.model_dump()}],settings)
