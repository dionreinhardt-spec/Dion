import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SCANNER_FILTERS, selectScannerTokens, hasRecentActivity } from '../lib/scanner-filters.ts';
const context = { fresh:true, connected:true, serverTime:1000 };
const flow = (buyers=100, patch={}) => ({ unique_buyers:buyers, unique_sellers:10, buys:1000, sells:10, net_flow_usd:1000, priced_fraction:1, max_wallet_volume_share:0.1, roundtrip_volume_share:0, ...patch });
const token = (id='A', buyers=100, patch={}) => ({ token:id, symbol:'TEST'+id, name:'Test fixture', status:'BLOCKED', evaluated_at:1000, last_event_at:999, windows:{'60':flow(buyers)}, market:null, score:20, plan:{allowed:false}, ...patch });
const filters = (patch={}) => ({...DEFAULT_SCANNER_FILTERS,preset:'trending',...patch});

test('100 distinct buyer wallets qualifies; 99 does not', () => {
  assert.deepEqual(selectScannerTokens([token('99',99),token('100',100)],filters(),context).map(t=>t.token),['100']);
});
test('many buys from the same wallet never becomes 100 buyers', () => {
  const value=token('one',1,{windows:{'60':flow(1,{buys:10000})}});
  assert.equal(selectScannerTokens([value],filters(),context).length,0);
});
test('uses the selected time window instead of lifetime or other window counts', () => {
  const value=token('windows',100,{windows:{'5':flow(3),'60':flow(100),'300':flow(600)}});
  assert.equal(selectScannerTokens([value],filters({windowKey:'5'}),context).length,0);
  assert.equal(selectScannerTokens([value],filters({windowKey:'300',minBuyers:500}),context).length,1);
});
test('stale, disconnected, old-token and future-token data cannot become current trends', () => {
  for(const patch of [{fresh:false},{connected:false},{serverTime:null}]) assert.equal(selectScannerTokens([token()],filters(),{...context,...patch}).length,0);
  for(const patch of [{last_event_at:984},{evaluated_at:994},{last_event_at:1100}]) assert.equal(hasRecentActivity(token('old',100,patch),context),false);
});
test('suspicious round trips are hidden by default but can be inspected explicitly', () => {
  const value=token('roundtrip',150,{windows:{'60':flow(150,{roundtrip_volume_share:0.9})}});
  assert.equal(selectScannerTokens([value],filters(),context).length,0);
  assert.equal(selectScannerTokens([value],filters({hideSuspicious:false}),context).length,1);
});
test('positive inflow needs reliable USD coverage and excludes missing or negative values', () => {
  for(const patch of [{net_flow_usd:null},{net_flow_usd:-1},{priced_fraction:0.2}]) {
    assert.equal(selectScannerTokens([token('flow',100,{windows:{'60':flow(100,patch)}})],filters({preset:'inflow'}),context).length,0);
  }
  assert.equal(selectScannerTokens([token()],filters({preset:'inflow'}),context).length,1);
});
test('a blocked token can be active without becoming an entry or changing permissions', () => {
  const value=Object.freeze(token('blocked'));
  assert.equal(selectScannerTokens([value],filters(),context).length,1);
  assert.equal(value.status,'BLOCKED'); assert.equal(value.plan.allowed,false);
  assert.equal(selectScannerTokens([value],filters({preset:'entries'}),context).length,0);
});
test('unknown liquidity is excluded when a minimum is requested', () => {
  const rich=token('rich',120,{market:{liquidity_usd:50000}});
  assert.deepEqual(selectScannerTokens([token('missing'),rich],filters({minLiquidity:25000}),context).map(t=>t.token),['rich']);
});
test('sorts observed buyer counts descending, handles missing fields and preserves input order', () => {
  const rows=[token('low',20),token('missing',0,{windows:{}}),token('high',250)];
  const result=selectScannerTokens(rows,filters({preset:'all'}),context);
  assert.deepEqual(result.map(t=>t.token),['high','low','missing']);
  assert.deepEqual(rows.map(t=>t.token),['low','missing','high']);
});
test('search and status apply together, including a full contract address', () => {
  const rows=[token('MintAddressX',200),token('other',300,{status:'WATCH'})];
  assert.deepEqual(selectScannerTokens(rows,filters({query:'  mintaddressx  ',status:'BLOCKED'}),context).map(t=>t.token),['MintAddressX']);
});
test('unknown or invalid buyer counts never qualify as trending', () => {
  for(const buyers of [NaN,Infinity,null,-1,100.5]) assert.equal(selectScannerTokens([token('invalid',buyers)],filters(),context).length,0);
});
test('partial observed windows can show observed buyers without claiming coverage or permission', () => {
  const value=token('partial',101,{window_coverage:{'60':{complete:false,observed_seconds:20}}});
  assert.equal(selectScannerTokens([value],filters(),context).length,1);
  assert.equal(value.window_coverage['60'].complete,false);
  assert.equal(value.plan.allowed,false);
});

test('one-minute trend includes observed buying 45 seconds ago but a 30-second window does not', () => {
  const value=token('within-minute',100,{last_event_at:955,windows:{'60':flow(100),'30':flow(0)}});
  assert.equal(selectScannerTokens([value],filters(),context).length,1);
  assert.equal(selectScannerTokens([value],filters({windowKey:'30'}),context).length,0);
});
