import test from 'node:test';
import assert from 'node:assert/strict';
import { chartIdentity, chartInterval, chooseChartPool, parseCandles, readChartData } from '../lib/coin-chart.ts';
import { createChartService } from '../lib/chart-service.ts';
const MINT='eSeeb8yCYH5buEBewAGWduuNf8xGbpdXrEEu49zpump';
const OTHER='EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SOL='So11111111111111111111111111111111111111112';
const POOL='5NfPPewxzJNhvPsRcfmkG9qwv4ZPGdwAaaEqmnMzqtmE';
const NOW=1800000000000;
const barTime=Math.floor(NOW/60000)*60-120;
const pool=(base=MINT,quote=SOL,liquidity='10000')=>({id:'solana_'+POOL,attributes:{address:POOL,name:'fixture / SOL',reserve_in_usd:liquidity},relationships:{base_token:{data:{id:'solana_'+base}},quote_token:{data:{id:'solana_'+quote}},dex:{data:{id:'fixture-dex'}}}});
const history=()=>({data:{attributes:{ohlcv_list:[[barTime+60,1,3,0.5,2,100],[barTime,0.7,2,0.5,1,50]]}}});
const json=body=>new Response(JSON.stringify(body),{headers:{'content-type':'application/json'}});
function fakeService(options={}) {
  let calls=0,clock=NOW,fail=false;
  const urls=[];
  const service=createChartService({now:()=>clock,fetcher:async url=>{calls++;urls.push(String(url));if(fail)throw new Error('network');return String(url).includes('/ohlcv/')?json(history()):json({data:[pool()]});},...options});
  return {service,calls:()=>calls,urls,advance:ms=>clock+=ms,fail:()=>fail=true};
}
test('validates actual Solana address bytes, supported chain and intervals',()=>{
  assert.deepEqual(chartIdentity('SOLANA',MINT),{chain:'solana',token:MINT});
  for(const bad of ['BTCUSDT','https://evil.test','111111111111111111111111111111111','0'.repeat(44)]) assert.throws(()=>chartIdentity('solana',bad));
  assert.throws(()=>chartIdentity('ethereum',MINT));assert.throws(()=>chartInterval('7s'));
});
test('never substitutes a same-name pool with a different token contract',()=>{
  assert.throws(()=>chooseChartPool({data:[pool(OTHER,SOL)]},'solana',MINT),/Contract/);
});
test('selects the requested quote token correctly rather than drawing the base token',()=>{
  assert.equal(chooseChartPool({data:[pool(SOL,MINT)]},'solana',MINT).tokenSide,'quote');
});
test('chooses liquidity only among pools with an exact token match',()=>{
  const result=chooseChartPool({data:[pool(OTHER,SOL,'999999'),pool(MINT,SOL,'20')]},'solana',MINT);
  assert.equal(result.baseToken,MINT);assert.equal(result.liquidityUsd,20);
});
test('parses authentic OHLCV ordering and removes duplicates without creating missing bars',()=>{
  const body=history();body.data.attributes.ohlcv_list.push(body.data.attributes.ohlcv_list[0]);
  const result=parseCandles(body,'1m',NOW/1000);
  assert.deepEqual(result.map(b=>b.time),[barTime,barTime+60]);assert.equal(result.length,2);
});
test('invalid prices, impossible ranges, future timestamps and nulls never create candles',()=>{
  for(const row of [[barTime,1,0.5,0.2,2,5],[barTime,null,2,0.2,1,5],[barTime+600,1,2,0.5,1,5],[barTime,1,2,0.5,1,-1]]) {
    assert.throws(()=>parseCandles({data:{attributes:{ohlcv_list:[row]}}},'1m',NOW/1000));
  }
  assert.deepEqual(parseCandles({data:{attributes:{ohlcv_list:[]}}},'1m',NOW/1000),[]);
});
test('concurrent requests share pool and candle fetches and cached reads cost no provider requests',async()=>{
  const value=fakeService();
  const results=await Promise.all([value.service.get('solana',MINT,'1m'),value.service.get('solana',MINT,'1m')]);
  assert.equal(value.calls(),2);assert.deepEqual(results[0],results[1]);
  await value.service.get('solana',MINT,'1m');assert.equal(value.calls(),2);
});
test('unknown contracts are negatively cached without unrelated fallback symbols',async()=>{
  let calls=0;const service=createChartService({now:()=>NOW,fetcher:async()=>{calls++;return json({data:[]});}});
  await assert.rejects(service.get('solana',MINT,'1m'),/Contract/);
  await assert.rejects(service.get('solana',MINT,'1m'),/Contract/);assert.equal(calls,1);
});
test('USD OHLCV requests explicitly select quote orientation when required',async()=>{
  const urls=[];const service=createChartService({now:()=>NOW,fetcher:async url=>{urls.push(String(url));return String(url).includes('/ohlcv/')?json(history()):json({data:[pool(SOL,MINT)]});}});
  await service.get('solana',MINT,'1m');assert.match(urls[1],/token=quote/);assert.match(urls[1],/currency=usd/);assert.match(urls[1],/include_empty_intervals=false/);
});
test('provider failure preserves clearly stale history and does not refresh its received timestamp',async()=>{
  const value=fakeService();const first=await value.service.get('solana',MINT,'1m');value.advance(61000);value.fail();
  const stale=await value.service.get('solana',MINT,'1m');assert.equal(stale.stale,true);assert.equal(stale.fetchedAt,first.fetchedAt);assert.ok(stale.warning);
});
test('very old cached data is not silently served after a provider outage',async()=>{
  const value=fakeService();await value.service.get('solana',MINT,'1m');value.advance(901000);value.fail();await assert.rejects(value.service.get('solana',MINT,'1m'));
});
test('429 Retry-After pauses the provider instead of repeated calls',async()=>{
  let calls=0;const service=createChartService({now:()=>NOW,fetcher:async()=>{calls++;return new Response('',{status:429,headers:{'retry-after':'120'}});}});
  await assert.rejects(service.get('solana',MINT,'1m'),error=>error.status===429&&error.retryAfter===120);
  await assert.rejects(service.get('solana',OTHER,'1m'),error=>error.status===429);assert.equal(calls,1);
});
test('responses for the wrong contract or interval are rejected before drawing',async()=>{
  const value=fakeService();const data=await value.service.get('solana',MINT,'1m');
  assert.equal(readChartData(data,{chain:'solana',token:MINT,symbol:'fixture'},'1m').token,MINT);
  assert.throws(()=>readChartData(data,{chain:'solana',token:OTHER,symbol:'fixture'},'1m'));
  assert.throws(()=>readChartData(data,{chain:'solana',token:MINT,symbol:'fixture'},'5m'));
});

test('shared provider budget permits at most eight calls per minute across chart intervals and tokens',async()=>{
  let calls=0;
  const service=createChartService({now:()=>NOW,fetcher:async url=>{
    calls++;const u=String(url);
    if(u.includes('/ohlcv/'))return json({data:{attributes:{ohlcv_list:[]}}});
    const mint=decodeURIComponent(u.split('/tokens/')[1].split('/')[0]);
    return json({data:[pool(mint,SOL)]});
  }});
  for(const interval of ['1m','5m','15m','1h','1d'])await service.get('solana',MINT,interval);
  await service.get('solana',OTHER,'1m');assert.equal(calls,8);
  await assert.rejects(service.get('solana',OTHER,'5m'),error=>error.status===429);assert.equal(calls,8);
});
