import test from 'node:test';import assert from 'node:assert/strict';
test('slow browser sampling cannot accumulate a backlog ahead of user requests',async()=>{
  const {WorkQueue}=await import('../lib/queue.mjs');const q=new WorkQueue(),order=[];
  let release;const blocked=new Promise(r=>release=r);
  q.sample(async()=>{await blocked;order.push('sample');});
  for(let i=0;i<20;i++)q.sample(async()=>order.push('redundant'));
  const request=q.run(async()=>order.push('request'));release();await request;
  assert.deepEqual(order,['sample','request']);
  await q.run(async()=>{throw new Error('broken request');}).catch(()=>{});
  assert.equal(await q.run(async()=>42),42);
});
