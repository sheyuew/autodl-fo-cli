import test from 'node:test';import assert from 'node:assert/strict';
import{readFile}from'node:fs/promises';import{join}from'node:path';
import{provisionFixture,creation,policy,until,GB}from'./provision-service-fixture.mjs';
test('RPC create and clone bind quoted configuration to one account and require one-use confirmation',async t=>{
 const f=await provisionFixture(t),a=await f.start('alice'),b=await f.start('bob');await f.login(a.request);await f.login(b.request,'bob@team');
 const catalog=await a.request({op:'provision-catalog',args:{machineId:123}});assert.equal(catalog.machines[0].machine_id,123);assert.doesNotMatch(JSON.stringify(catalog),/must-not-leak/);
 const p=await a.request({op:'provision-prepare',mode:'create',args:creation});assert.equal(p.quote.totalHourly,2.22);
 await assert.rejects(a.request({op:'provision-execute',planId:p.id}),{code:'CONFIRMATION_REQUIRED'});
 await assert.rejects(b.request({op:'provision-execute',planId:p.id,confirmed:true}),{code:'PLAN_EXPIRED'});
 assert.equal(f.seen.filter(q=>q.path.endsWith('/create/payg')).length,0);
 assert.equal((await a.request({op:'provision-execute',planId:p.id,confirmed:true})).instanceUuid,'created');
 await assert.rejects(a.request({op:'provision-execute',planId:p.id,confirmed:true}),{code:'PLAN_EXPIRED'});
 const clone=await a.request({op:'provision-prepare',mode:'clone',args:{machineId:123,gpuCount:1,sourceInstanceUuid:'source',copyDataDisk:true,dataDiskGB:10}});
 await a.request({op:'provision-execute',planId:clone.id,confirmed:true});assert.equal(f.seen.filter(q=>q.path.endsWith('/clone/payg')).length,1);
});
test('RPC disk expansion previews the target and price then submits the verified increment exactly once',async t=>{
 const f=await provisionFixture(t),a=await f.start('alice');await f.login(a.request);
 const p=await a.request({op:'instance-prepare',instanceUuid:'source',action:'expandDataDisk',args:{sizeGB:20}});
 assert.equal(p.diskChange.currentTotalGB,60);assert.equal(p.diskChange.targetTotalGB,70);assert.equal(p.quote.storageDaily,.96);
 assert.equal(f.seen.filter(q=>q.path.endsWith('/data_disk/change')).length,0);
 await a.request({op:'instance-execute',planId:p.id,confirmed:true});const write=f.seen.find(q=>q.path.endsWith('/data_disk/change'));assert.equal(write.body.change_size,10*GB);
});
test('background acquisition only completes after the provider reports running and records no credentials',async t=>{
 const f=await provisionFixture(t),a=await f.start('alice');await f.login(a.request);
 const p=await a.request({op:'task-prepare',policy});assert.equal(p.oneSuccessOnly,true);assert.equal(p.candidate.gpuName,'RTX 4090');assert.equal(p.candidate.dataDiskGB,10);
 assert.equal(f.seen.filter(q=>q.path.endsWith('/create/payg')).length,0);
 await assert.rejects(a.request({op:'task-start',planId:p.planId}),{code:'CONFIRMATION_REQUIRED'});
 const task=await a.request({op:'task-start',planId:p.planId,confirmed:true});
 const result=await until(async()=>{const r=await a.request({op:'task-info',taskId:task.id});return r.state==='completed'&&r;});
 assert.equal(result.instanceUuid,'created');assert.equal(f.seen.filter(q=>q.path.endsWith('/create/payg')).length,1);
 const other=await f.start('bob');await f.login(other.request,'bob@team');assert.deepEqual(await other.request({op:'task-list'}),[]);
 const stored=await readFile(join(a.profile,'resource-tasks.json'),'utf8');assert.doesNotMatch(stored,/fixture-password|fixture-private-token|must-not-leak/);
 const notifications=await a.request({op:'notifications'});assert.ok(notifications.events.some(e=>e.kind==='success'&&e.instanceUuid==='created'));
});
test('a misconfigured acquisition image fails during preview instead of being hidden as empty stock',async t=>{
 const f=await provisionFixture(t),a=await f.start('alice');await f.login(a.request);
 await assert.rejects(a.request({op:'task-prepare',policy:{...policy,imageUuid:'not-an-image'}}),{code:'IMAGE_REQUIRED'});
 assert.equal(f.seen.filter(q=>q.path.endsWith('/create/payg')).length,0);
});
test('automatic tasks remain visible after restart and never silently resume paid authorization',async t=>{
 const f=await provisionFixture(t);f.state.idle=0;const a=await f.start('alice');await f.login(a.request);
 const p=await a.request({op:'task-prepare',policy});const task=await a.request({op:'task-start',planId:p.planId,confirmed:true});await a.service.close();
 const restarted=await f.start('alice');const records=await restarted.request({op:'task-list'});assert.equal(records.find(r=>r.id===task.id).state,'paused');assert.equal((await restarted.request({op:'doctor'})).authenticated,false);
 f.state.idle=2;await f.login(restarted.request);await new Promise(resolve=>setTimeout(resolve,100));assert.equal(f.seen.filter(q=>q.path.endsWith('/create/payg')).length,0);
});
test('closing a session rejects queued paid operations whose acknowledgements can no longer be delivered',async t=>{
 const f=await provisionFixture(t),a=await f.start('alice');await f.login(a.request);
 const p=await a.request({op:'provision-prepare',mode:'create',args:creation});let release;
 f.state.instanceGate=new Promise(resolve=>{release=resolve;});
 const before=f.seen.length,reading=a.request({op:'instances'}).catch(()=>{});await until(()=>f.seen.length>before);
 const paying=a.request({op:'provision-execute',planId:p.id,confirmed:true}).catch(()=>{});await new Promise(resolve=>setTimeout(resolve,30));
 const closing=a.service.close();release();await Promise.all([reading,paying,closing]);
 assert.equal(f.seen.filter(q=>q.path.endsWith('/create/payg')).length,0);
});
