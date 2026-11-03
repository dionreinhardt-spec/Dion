import base64
import hashlib
import json
from pathlib import Path
import pytest
from axiom_intel.adapters.borsh import AnchorSchema, Reader, DecodeError, program_events
from axiom_intel.models import PUMP


def complete_event():
    schema=AnchorSchema("pump")
    discriminator=next(d for d,n in schema.events.items() if n=="CompleteEvent")
    data=discriminator + bytes([1])*32 + bytes([2])*32 + bytes([3])*32 + (1800000000).to_bytes(8,"little",signed=True) + bytes([4])*32
    return schema, data


def test_real_program_discriminator_and_fields():
    schema,data=complete_event()
    name,value=schema.decode(data)
    assert name=="CompleteEvent" and value["timestamp"]==1800000000
    assert len(value["mint"])>30


def test_spoofed_event_from_other_program_rejected():
    schema,data=complete_event()
    other="11111111111111111111111111111111"
    logs=[f"Program {other} invoke [1]","Program data: "+base64.b64encode(data).decode(),f"Program {other} success"]
    assert list(program_events(logs,{PUMP:schema}))==[]


def test_nested_success_and_failed_cpi_rollback():
    schema,data=complete_event();other="11111111111111111111111111111111"
    logs=[f"Program {other} invoke [1]",f"Program {PUMP} invoke [2]","Program data: "+base64.b64encode(data).decode(),f"Program {PUMP} failed: custom program error: 1",f"Program {other} success"]
    assert not list(program_events(logs,{PUMP:schema}))
    logs[-2]=f"Program {PUMP} success"
    assert len(list(program_events(logs,{PUMP:schema})))==1
    logs[-1]=f"Program {other} failed: rollback"
    assert not list(program_events(logs,{PUMP:schema}))


def test_schema_drift_and_truncated_event_fail_closed():
    schema,data=complete_event()
    with pytest.raises(DecodeError): schema.decode(data+b'\0')
    with pytest.raises(DecodeError): schema.decode(data[:-3])


def test_signed_virtual_reserves_not_unsigned():
    r=Reader((-100).to_bytes(16,'little',signed=True),{})
    assert r.read('i128')==-100


def test_bounded_borsh_string_and_vec():
    with pytest.raises(DecodeError): Reader((999999).to_bytes(4,'little'),{}).read('string')
    with pytest.raises(DecodeError): Reader((999999).to_bytes(4,'little'),{}).read({'vec':'u64'})


def test_incomplete_logs_not_accepted():
    schema,data=complete_event()
    with pytest.raises(DecodeError): list(program_events([f"Program {PUMP} invoke [1]"],{PUMP:schema}))


def test_recorded_mainnet_schema_drift_is_observation_only():
    import time
    fixture=Path(__file__).parents[1]/'fixtures'/'real-pump-logs.json'
    job=json.loads(fixture.read_text())
    schema=AnchorSchema('pump',allow_unknown_tail=True)
    events=list(program_events(job['logs'],{PUMP:schema}))
    trade=next(e[3] for e in events if e[2]=='TradeEvent')
    assert trade['_unverified_tail_bytes']==8
    assert trade['quote_amount']==trade['sol_amount']
    assert trade['ix_name']=='sell'

async def test_recorded_mainnet_trade_has_provenance_and_schema_warning(settings):
    import asyncio,time
    from axiom_intel.adapters.solana import SolanaAdapter
    from axiom_intel.models import WSOL
    class P:
        def quote(self,mint,now):return (100.,now-1)
    job=json.loads((Path(__file__).parents[1]/'fixtures'/'real-pump-logs.json').read_text())
    # Keep the recorded timestamp for regression testing; no claim of live data.
    event_time=1793576546
    job['received_at']=event_time+1
    status={'rejected_time':0,'unsupported_quote':0}
    adapter=SolanaAdapter(settings,P(),asyncio.Queue(),status)
    results=[(k,v) async for k,v in adapter.decode(job)]
    e=next(v for k,v in results if k=='trade')
    assert e.signature==job['signature'] and e.quote_mint==WSOL and e.schema_warning
