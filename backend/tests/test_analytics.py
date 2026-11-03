from axiom_intel.analytics import flow, analyze, DEFAULT_WEIGHTS
from conftest import TOKEN, NOW, trade, market, security


def test_windows_exclude_future_and_boundary():
    rows = [trade(0, at=NOW-30), trade(1, at=NOW-29), trade(2, at=NOW+1)]
    f = flow(rows, NOW, 30)
    assert f["trades"] == 1 and f["net_flow_usd"] == 100


def test_unpriced_is_missing_not_zero():
    e = trade(); e.quote_usd = None
    f = flow([e], NOW, 30)
    assert f["net_flow_usd"] is None and f["priced_fraction"] == 0


def test_distinct_buyers_and_suspicious_roundtrip():
    f = flow([trade(0,wallet="a"), trade(1,side="sell",wallet="a"), trade(2,wallet="b")], NOW, 30)
    assert f["unique_buyers"] == 2
    assert abs(f["roundtrip_volume_share"] - 2/3) < .00001


def test_missing_features_never_renormalized(settings):
    result = analyze(TOKEN, [trade()], market(), security(), settings, NOW, NOW-120, True, DEFAULT_WEIGHTS)
    assert result["features"]["smart_money"] is None
    assert result["contributions"]["smart_money"] == 0
    assert result["score"] <= 70
    assert result["scam_probability"] is None


def test_stale_stream_and_security_block_entries(settings):
    sec=security();sec.freeze_authority="authority";sec.blockers=["Active freeze authority"]
    result=analyze(TOKEN,[trade()],market(NOW-200),sec,settings,NOW,NOW-120,False,DEFAULT_WEIGHTS)
    assert result["status"] == "BLOCKED"
    assert len(result["blockers"]) >= 3


def test_price_disagreement_blocks(settings):
    result=analyze(TOKEN,[trade(price=2)],market(),security(),settings,NOW,NOW-120,True,DEFAULT_WEIGHTS)
    assert any("Preisabweichung" in b for b in result["blockers"])


def test_partial_window_never_claims_24h_coverage(settings):
    r=analyze(TOKEN,[trade()],market(),security(),settings,NOW,NOW-120,True,DEFAULT_WEIGHTS)
    assert not r["window_coverage"]["86400"]["complete"]
    assert r["window_coverage"]["60"]["complete"]


def test_sustained_independent_momentum_can_qualify(settings):
    rows=[trade(i,at=NOW-59+i,usd=50,price=.93) for i in range(20)]
    rows += [trade(100+i,at=NOW-29+i,usd=300,price=1) for i in range(29)]
    r=analyze(TOKEN,rows,market(),security(),settings,NOW,NOW-120,True,DEFAULT_WEIGHTS)
    assert r["status"] == "ENTRY_CANDIDATE", r
    assert r["score"] < 100


def test_unknown_event_tail_blocks_even_strong_momentum(settings):
    rows=[trade(i,at=NOW-59+i,usd=50,price=.93) for i in range(20)]
    rows += [trade(100+i,at=NOW-29+i,usd=300,price=1) for i in range(29)]
    rows[-1].schema_warning='Unreviewed tail'
    r=analyze(TOKEN,rows,market(),security(),settings,NOW,NOW-120,True,DEFAULT_WEIGHTS)
    assert r['status']=='BLOCKED'
    assert any('IDL' in b for b in r['blockers'])


def test_same_second_prices_follow_slot_order(settings):
    earlier=trade(99,at=NOW-1,price=.9);earlier.slot=100
    later=trade(1,at=NOW-1,price=1);later.slot=101
    result=analyze(TOKEN,[later,earlier],market(),security(),settings,NOW,NOW-120,True,DEFAULT_WEIGHTS)
    assert result['price_usd']==1
