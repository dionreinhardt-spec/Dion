import test from 'node:test';
import assert from 'node:assert/strict';
import { isSolanaAddress } from '../lib/coin-chart.ts';
import { TOKEN_PROGRAMS, SYSTEM_PROGRAM, parseWalletBalances, holdingsForToken, activeHoldings, currentFlags, parseHolders, launchEvidence, insiderFlags, parseDexMarkets } from '../lib/wallet-intelligence.ts';
import { WALLET_REGISTRY } from '../lib/wallet-registry.ts';
import { createIntelligenceService } from '../lib/wallet-intelligence-service.ts';
const [SPL, T22] = TOKEN_PROGRAMS;
const MINT='eSeeb8yCYH5buEBewAGWduuNf8xGbpdXrEEu49zpump', OTHER='EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const WALLET=WALLET_REGISTRY[0].wallet, W2=WALLET_REGISTRY[3].wallet, W3=WALLET_REGISTRY[4].wallet;
const A='5NfPPewxzJNhvPsRcfmkG9qwv4ZPGdwAaaEqmnMzqtmE', B='NHCcmvWSwGh3qSjNSs8HHcWv4Lt3Xg6osmg6aDeAqvQ';
const NOW=1800000000;
const json=body=>new Response(JSON.stringify(body),{headers:{'content-type':'application/json'}});
const context=(value,slot=100)=>({context:{slot},value});
const account=(wallet=WALLET,amount='100000000',mint=MINT,program=SPL,precision=6)=>({owner:program,executable:false,data:{parsed:{type:'account',info:{owner:wallet,mint,state:'initialized',tokenAmount:{amount,decimals:precision}}}}});
const row=(address=A,wallet=WALLET,amount='100000000',mint=MINT,program=SPL)=>({pubkey:address,account:account(wallet,amount,mint,program)});
const plain=()=>({owner:SYSTEM_PROGRAM,executable:false,data:['','base64']});
const label={...WALLET_REGISTRY[0]};
const scan=(raw='100000000',checkedAt=NOW)=>({wallet:WALLET,program:SPL,slot:100,checkedAt,error:null,balances:{[MINT]:{mint:MINT,raw,decimals:6}}});
const token=(overrides={})=>({token:MINT,chain:'solana',symbol:'fixture',name:'fixture',priceUsd:1,marketAt:NOW,liquidityUsd:50000,marketCap:100000,kol:[],inspection:null,...overrides});

test('registry has real distinct address syntax and sourced provider attributions',()=>{
  assert.equal(new Set(WALLET_REGISTRY.map(l=>l.wallet)).size,WALLET_REGISTRY.length);
  assert.ok(WALLET_REGISTRY.every(l=>isSolanaAddress(l.wallet)&&l.source.endsWith(l.wallet)&&l.labelCheckedAt==='2026-11-25'));
  assert.equal(WALLET_REGISTRY.filter(l=>l.name==='Cupsey').length,3);
});
test('multiple token accounts sum exact raw integers and zero balances disappear',()=>{
  const body=context([row(A,WALLET,'9007199254740993000'),row(B,WALLET,'123')]);
  assert.equal(parseWalletBalances(body,WALLET,SPL)[MINT].raw,'9007199254740993123');
  assert.deepEqual(parseWalletBalances(context([row(A,WALLET,'0')]),WALLET,SPL),{});
});
test('wallet parsers fail closed on wrong wallet, token program, duplicate account and invalid raw amount',()=>{
  assert.throws(()=>parseWalletBalances(context([row(A,W2)]),WALLET,SPL));
  assert.throws(()=>parseWalletBalances(context([row(A,WALLET,'1',MINT,T22)]),WALLET,SPL));
  assert.throws(()=>parseWalletBalances(context([row(),row()]),WALLET,SPL));
  assert.throws(()=>parseWalletBalances(context([row(A,WALLET,'NaN')]),WALLET,SPL));
  assert.throws(()=>parseWalletBalances({value:[]},WALLET,SPL));
});
test('holdings require exact mint, fresh scan and unique wallet; a same label is not another independent person',()=>{
  const held=holdingsForToken(MINT,[label,label],[scan()],NOW,1);
  assert.equal(held.length,1);assert.equal(held[0].valueUsd,100);
  assert.equal(holdingsForToken(OTHER,[label],[scan()],NOW,1).length,0);
  assert.equal(holdingsForToken(MINT,[label],[scan()],NOW+601,1).length,0);
  assert.equal(holdingsForToken(MINT,[label],[scan(),{...scan(),program:T22}],NOW,1).length,0);
});
test('dust and unpriced holdings do not become default KOL entries',()=>{
  const small=token({kol:holdingsForToken(MINT,[label],[scan('1000000')],NOW,0.1)});
  assert.equal(activeHoldings(small,NOW).length,0);
  const unpriced=token({kol:holdingsForToken(MINT,[label],[scan()],NOW,null)});
  assert.equal(activeHoldings(unpriced,NOW).length,0);assert.equal(activeHoldings(unpriced,NOW,true).length,1);
});
test('holder grouping aggregates owners and excludes program/pool accounts from ordinary wallet concentration',()=>{
  const supply=context({amount:'1000',decimals:6}), largest=context([{address:A},{address:B}]);
  const accounts=context([account(WALLET,'100'),account(WALLET,'200')]);
  const owners=new Map([[WALLET,plain()]]);
  const grouped=parseHolders(MINT,supply,largest,accounts,owners);
  assert.equal(grouped.length,1);assert.equal(grouped[0].share,0.3);
  assert.equal(insiderFlags(grouped,{signer:null,funded:[]})[0].kind,'distribution');
  const pool=parseHolders(MINT,supply,context([{address:A}]),context([account(W2,'900')]),new Map([[W2,{owner:SPL,executable:false,data:['AA==','base64']}]]));
  assert.equal(pool[0].ordinaryWallet,false);assert.equal(insiderFlags(pool,{signer:null,funded:[]}).length,0);
});
test('wrong-mint holders, duplicated accounts and supply inconsistencies cannot generate risk evidence',()=>{
  const supply=context({amount:'100',decimals:6}), largest=context([{address:A}]);
  assert.throws(()=>parseHolders(MINT,supply,largest,context([account(WALLET,'10',OTHER)]),new Map()));
  assert.throws(()=>parseHolders(MINT,supply,largest,context([account(WALLET,'101')]),new Map()));
  assert.throws(()=>parseHolders(MINT,supply,context([{address:A},{address:A}]),context([account(),account()]),new Map()));
});
const launch=(mint=MINT,err=null)=>({meta:{err,innerInstructions:[{instructions:[{programId:SPL,parsed:{type:'initializeMint2',info:{mint}}},{programId:SYSTEM_PROGRAM,parsed:{type:'transfer',info:{source:WALLET,destination:W2,lamports:10000000}}}]}]},transaction:{message:{accountKeys:[{pubkey:WALLET,signer:true}],instructions:[]}}});
test('launch attribution requires successful exact-mint initialization; generic fee payer is insufficient',()=>{
  assert.equal(launchEvidence(launch(),MINT).signer,WALLET);
  assert.deepEqual(launchEvidence(launch(OTHER),MINT),{signer:null,funded:[]});
  assert.equal(launchEvidence(launch(MINT,{InstructionError:[0,'Custom']}),MINT).signer,null);
  assert.equal(launchEvidence({meta:{err:null},transaction:{message:{accountKeys:[{pubkey:WALLET,signer:true}],instructions:[]}}},MINT).signer,null);
});
test('launch links, explicit funding and plain concentration are different evidence types',()=>{
  const holders=[{wallet:WALLET,raw:'60',share:.06,ordinaryWallet:true},{wallet:W2,raw:'20',share:.02,ordinaryWallet:true}];
  const flags=insiderFlags(holders,launchEvidence(launch(),MINT));
  assert.deepEqual(flags.map(f=>f.id),['launch_holder','launch_funding']);
  assert.ok(flags.every(f=>f.kind==='launch_link'));
  assert.equal(insiderFlags([{wallet:W3,share:.4,ordinaryWallet:true}],{signer:null,funded:[]})[0].kind,'distribution');
  assert.equal(insiderFlags([{...holders[1],share:.001}],launchEvidence(launch(),MINT)).length,0);
});
test('expired and failed inspections never become current insider badges',()=>{
  const inspection={checkedAt:NOW,error:null,flags:[{id:'concentration'}]};
  assert.equal(currentFlags(token({inspection}),NOW).length,1);
  assert.equal(currentFlags(token({inspection}),NOW+901).length,0);
  assert.equal(currentFlags(token({inspection:{...inspection,error:'timeout'}}),NOW).length,0);
});
test('Dexscreener metadata is exact-mint and base-side only; same ticker and quote side cannot substitute',()=>{
  const pair=(mint=MINT,liq=100)=>({chainId:'solana',baseToken:{address:mint,symbol:'fixture',name:'fixture'},quoteToken:{address:OTHER},priceUsd:'2',liquidity:{usd:liq},marketCap:10000});
  const found=parseDexMarkets([pair(OTHER,100000),pair(MINT,20),pair(MINT,50)],new Set([MINT]),NOW);
  assert.equal(found.size,1);assert.equal(found.get(MINT).liquidityUsd,50);assert.equal(found.get(MINT).priceUsd,2);
  assert.equal(parseDexMarkets([pair(OTHER)],new Set([MINT]),NOW).size,0);
});
function fixture(options={}) {
  let clock=NOW,amount='100000000',fail=false,slot=100,calls=0;
  const urls=[];
  const service=createIntelligenceService({verifyGenesis:false,labels:[label],now:()=>clock,rpcBudget:8,fetcher:async (url,init={})=>{
    urls.push(String(url));
    if(String(url).includes('/api/snapshot'))return json({server_time:clock,scanner:[{token:MINT,chain:'solana',symbol:'fixture',market:{token:MINT,price_usd:1,received_at:clock,liquidity_usd:50000}}],launches:[]});
    if(String(url).includes('dexscreener'))return json([]);
    calls++;if(fail)throw new Error('timeout');const request=JSON.parse(init.body);
    return json({jsonrpc:'2.0',id:request.id,result:context(request.params[1].programId===SPL?[row(A,WALLET,amount)]:[],slot)});
  },...options});
  return {service,urls,calls:()=>calls,advance:s=>clock+=s,setAmount:value=>amount=value,setFail:()=>fail=true,setSlot:value=>slot=value};
}
test('a new successful empty wallet scan clears previous held tokens, including false persistent badges',async()=>{
  const f=fixture();await f.service.refreshSource();await f.service.scanWallet(label);
  assert.equal(f.service.snapshot().tokens[0].kol.length,1);
  f.advance(301);f.setAmount('0');await f.service.scanWallet(label);
  assert.equal(f.service.snapshot().tokens[0].kol.length,0);
});
test('RPC outage retains original receipt time and expires old holdings rather than inventing zero or refreshing timestamps',async()=>{
  const f=fixture();await f.service.refreshSource();await f.service.scanWallet(label);
  const receipt=f.service.snapshot().tokens[0].kol[0].checkedAt;
  f.advance(301);f.setFail();await f.service.scanWallet(label);
  assert.equal(f.service.snapshot().tokens[0].kol[0].checkedAt,receipt);
  assert.equal(f.service.snapshot().tokens[0].kol[0].valueUsd,null);
  f.advance(301);assert.equal(f.service.snapshot().tokens[0].kol.length,0);
  assert.ok(f.service.snapshot().wallets[0].error);
});
test('out-of-order confirmed slots cannot replace newer wallet balances',async()=>{
  const f=fixture();await f.service.refreshSource();await f.service.scanWallet(label);
  f.advance(301);f.setSlot(99);f.setAmount('0');await f.service.scanWallet(label);
  assert.equal(f.service.snapshot().tokens[0].kol.length,1);
  assert.equal(f.service.snapshot().tokens[0].kol[0].slot,100);
});
test('all callers share one RPC budget and HTTP 429 cooldown is honored',async()=>{
  const f=fixture();for(let i=0;i<8;i++)await f.service.rpc('getTokenAccountsByOwner',[WALLET,{programId:SPL}]);
  await assert.rejects(f.service.rpc('getTokenAccountsByOwner',[WALLET,{programId:SPL}]),/Budget/);assert.equal(f.calls(),8);
  let calls=0;const s=createIntelligenceService({verifyGenesis:false,now:()=>NOW,fetcher:async()=>{calls++;return new Response('{}',{status:429,headers:{'retry-after':'120'}});}});
  await assert.rejects(s.rpc('getTokenSupply',[MINT]));await assert.rejects(s.rpc('getTokenSupply',[MINT]),/Budget/);assert.equal(calls,1);
});
test('JSON-RPC errors inside HTTP 200 and mismatched response IDs are failures',async()=>{
  const error=createIntelligenceService({verifyGenesis:false,fetcher:async()=>json({jsonrpc:'2.0',id:1,error:{code:-32602,message:'fixture'}})});
  await assert.rejects(error.rpc('getTokenSupply',[MINT]));
  const wrong=createIntelligenceService({verifyGenesis:false,fetcher:async()=>json({jsonrpc:'2.0',id:999,result:context([])})});
  await assert.rejects(wrong.rpc('getTokenSupply',[MINT]),/zugeordnet/);
});
test('oversized responses and parallel tick calls are bounded',async()=>{
  const huge=createIntelligenceService({verifyGenesis:false,fetcher:async()=>new Response('{}',{headers:{'content-length':'12000001'}})});
  await assert.rejects(huge.rpc('getTokenSupply',[MINT]),/Größenlimit/);
  const f=fixture();await Promise.all(Array.from({length:20},()=>f.service.tick()));
  assert.equal(f.calls(),2);assert.equal(f.urls.filter(u=>u.includes('/api/snapshot')).length,1);
});
test('off-curve system-owned pool addresses are not counted as ordinary holder wallets',()=>{
  const result=parseHolders(MINT,context({amount:'100',decimals:6}),context([{address:B}]),context([account(A,'90')]),new Map([[A,plain()]]));
  assert.equal(result[0].ordinaryWallet,false);
  assert.equal(insiderFlags(result,{signer:A,funded:[]}).length,0);
});
test('complete holder inspection exposes launch and distribution evidence without modifying trading permissions',async()=>{
  let id=0;
  const service=createIntelligenceService({verifyGenesis:false,now:()=>NOW,labels:[],fullHolders:true,fetcher:async(url,init={})=>{
    const request=JSON.parse(init.body);id++;
    let result;
    if(request.method==='getTokenSupply')result=context({amount:'1000',decimals:6});
    else if(request.method==='getTokenLargestAccounts')result=context([{address:A},{address:B}]);
    else if(request.params[1].encoding==='jsonParsed')result=context([account(WALLET,'400'),account(W2,'200')]);
    else result=context([plain(),plain()]);
    return json({jsonrpc:'2.0',id:request.id,result});
  }});
  await service.inspectToken(MINT);
  assert.equal(id,4);assert.equal(service.snapshot().status.inspected,1);
});
test('a wrong Solana cluster blocks wallet reads before any balance is accepted',async()=>{
  const methods=[];
  const s=createIntelligenceService({fetcher:async(url,init)=>{const request=JSON.parse(init.body);methods.push(request.method);return json({jsonrpc:'2.0',id:request.id,result:'devnet-fixture-hash'});}});
  await assert.rejects(s.rpc('getTokenAccountsByOwner',[WALLET,{programId:SPL}]),/Mainnet/);
  assert.deepEqual(methods,['getGenesisHash']);
});
test('default insider path verifies launch-wallet holdings without the disabled public largest-holder method',async()=>{
  const signature='5Q2XTZP8NC4ajcQH5cLy8wqcbUDjjtKiET6RiFqJWuvUqxaxWEjKpCbX4nKv6VB91Z7WnyynccxNTQbRviYmAz4D';
  const methods=[];
  const s=createIntelligenceService({verifyGenesis:false,labels:[],now:()=>NOW,fetcher:async(url,init)=>{
    if(String(url).includes('/api/snapshot'))return json({server_time:NOW,scanner:[{token:MINT,chain:'solana',symbol:'fixture'}],launches:[{token:MINT,event:'CreateEvent',signature,timestamp:NOW,symbol:'fixture'}]});
    const request=JSON.parse(init.body);methods.push(request.method);let result;
    if(request.method==='getTransaction'){assert.equal(request.params[1].maxSupportedTransactionVersion,1);result=launch();}
    else if(request.method==='getTokenSupply')result=context({amount:'1000',decimals:6});
    else if(request.method==='getTokenAccountsByOwner')result=context([row(request.params[0]===WALLET?A:B,request.params[0],request.params[0]===WALLET?'100':'20')]);
    else if(request.method==='getMultipleAccounts')result=context([plain(),plain()]);
    else throw new Error('Unexpected RPC method');
    return json({jsonrpc:'2.0',id:request.id,result});
  }});
  await s.refreshSource();await s.inspectToken(MINT);const t=s.snapshot().tokens[0];
  assert.equal(t.inspection.error,null);assert.equal(t.inspection.coverage,'launch_wallets');
  assert.deepEqual(t.inspection.flags.map(f=>f.id),['launch_holder','launch_funding']);
  assert.equal(t.inspection.top3Share,null);assert.ok(!methods.includes('getTokenLargestAccounts'));
});
