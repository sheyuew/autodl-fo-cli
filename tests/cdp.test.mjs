import test from 'node:test';import assert from 'node:assert/strict';import {PassThrough} from 'node:stream';
test('pipe transport matches split responses to the correct concurrent requests',async()=>{
  const {PipeCDP}=await import('../lib/cdp.mjs');const out=new PassThrough(),input=new PassThrough();const c=new PipeCDP(out,input,500);
  let sent='';out.on('data',b=>{sent+=b.toString();});
  const a=c.call('A'),b=c.call('B');const requests=sent.split('\0').filter(Boolean).map(JSON.parse);
  input.write(JSON.stringify({id:requests[1].id,result:{value:'B'}})+'\0{"id":');
  input.write(requests[0].id+',"result":{"value":"A"}}\0');
  assert.deepEqual(await a,{value:'A'});assert.deepEqual(await b,{value:'B'});
});
test('request interception events retain the target session and do not consume replies',async()=>{
  const {PipeCDP}=await import('../lib/cdp.mjs'),out=new PassThrough(),input=new PassThrough(),c=new PipeCDP(out,input,1000);
  const seen=[];const off=c.on('Fetch.requestPaused',e=>seen.push(e));
  input.write(JSON.stringify({method:'Fetch.requestPaused',sessionId:'alice-page',params:{requestId:'r1'}})+'\0');
  off();input.write(JSON.stringify({method:'Fetch.requestPaused',sessionId:'bob-page',params:{requestId:'r2'}})+'\0');
  assert.equal(seen.length,1);assert.equal(seen[0].sessionId,'alice-page');assert.equal(seen[0].params.requestId,'r1');
});
test('pipe timeout rejects instead of leaving a request hanging',async()=>{
  const {PipeCDP}=await import('../lib/cdp.mjs');const c=new PipeCDP(new PassThrough(),new PassThrough(),10);
  await assert.rejects(c.call('Never'),/超时/);
});
