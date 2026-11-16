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
test('acquisition waits when every host lacks disk expansion and matches a later host capacity change',async t=>{
 const f=await provisionFixture(t),a=await f.start('alice');await f.login(a.request);f.state.machines[0].max_data_disk_expand_size=5*GB;
 const waiting=await a.request({op:'task-prepare',policy});assert.equal(waiting.candidate,null);
 f.state.machines[0].max_data_disk_expand_size=20*GB;
 const ready=await a.request({op:'task-prepare',policy});assert.equal(ready.candidate.machineId,123);assert.equal(ready.candidate.totalDataDiskGB,60);
 assert.equal(f.seen.filter(q=>q.path.endsWith('/create/payg')).length,0);
});
test('acquisition checks later regions and hosts after disk, rental-count and image mismatches',async t=>{
 const f=await provisionFixture(t),a=await f.start('alice');await f.login(a.request);const base=f.state.machines[0];
 f.state.machines=[{...base,max_data_disk_expand_size:5*GB},{...base,machine_id:124,rent_mode:'Base4',gpu_idle_num:4},{...base,machine_id:125,cpu_arch:'arm64'},{...base,machine_id:126,region_sign:'east-B'}];
 const plan=await a.request({op:'task-prepare',policy:{...policy,regionSigns:['west-A','east-B']}});assert.equal(plan.candidate.machineId,126);assert.equal(plan.candidate.regionSign,'east-B');assert.equal(plan.candidate.totalDataDiskGB,60);
 assert.equal(f.seen.filter(q=>q.path.endsWith('/create/payg')).length,0);
});
test('minimum total disk uses each host free capacity and quotes only the required extra disk',async t=>{
 const f=await provisionFixture(t),a=await f.start('alice');await f.login(a.request);const base=f.state.machines[0],{dataDiskGB,...minimum}=policy;
 f.state.machines=[{...base,max_instance_disk_size:40*GB,max_data_disk_expand_size:10*GB},{...base,machine_id:124,max_instance_disk_size:50*GB,max_data_disk_expand_size:30*GB}];
 let plan=await a.request({op:'task-prepare',policy:{...minimum,minDataDiskGB:70}});assert.equal(plan.candidate.machineId,124);assert.equal(plan.candidate.freeDataDiskGB,50);assert.equal(plan.candidate.dataDiskGB,20);assert.equal(plan.candidate.totalDataDiskGB,70);assert.equal(plan.candidate.quote.totalHourly,2.24);
 f.state.machines=[{...base,machine_id:125,max_instance_disk_size:80*GB,max_data_disk_expand_size:0}];
 plan=await a.request({op:'task-prepare',policy:{...minimum,minDataDiskGB:70}});assert.equal(plan.candidate.machineId,125);assert.equal(plan.candidate.dataDiskGB,0);assert.equal(plan.candidate.totalDataDiskGB,80);assert.equal(plan.candidate.quote.totalHourly,2.2);
 assert.equal(f.seen.filter(q=>q.path.endsWith('/create/payg')).length,0);
});
test('minimum total disk is rechecked after inventory and host details disagree about free capacity',async t=>{
 const f=await provisionFixture(t),a=await f.start('alice');await f.login(a.request);const base=f.state.machines[0],{dataDiskGB,...minimum}=policy;
 f.state.machines=[base,{...base,machine_id:124}];f.state.machineDetails={'123':{max_instance_disk_size:40*GB}};
 const plan=await a.request({op:'task-prepare',policy:{...minimum,minDataDiskGB:70}});assert.equal(plan.candidate.machineId,123);assert.equal(plan.candidate.freeDataDiskGB,40);assert.equal(plan.candidate.totalDataDiskGB,70);assert.equal(plan.candidate.dataDiskGB,30);
 assert.equal(f.seen.filter(q=>q.path.endsWith('/create/payg')).length,0);
});
test('minimum total disk avoids paid expansion when host details provide more free disk than the inventory snapshot',async t=>{
 const f=await provisionFixture(t),a=await f.start('alice');await f.login(a.request);const {dataDiskGB,...minimum}=policy;
 f.state.machines[0].max_data_disk_expand_size=0;
 f.state.machineDetails={'123':{max_instance_disk_size:80*GB}};
 const plan=await a.request({op:'task-prepare',policy:{...minimum,minDataDiskGB:70}});assert.ok(plan.candidate,'current host details meet the minimum without paid expansion');assert.equal(plan.candidate.dataDiskGB,0);assert.equal(plan.candidate.totalDataDiskGB,80);assert.equal(plan.candidate.quote.totalHourly,2.2);
 assert.equal(f.seen.filter(q=>q.path.endsWith('/create/payg')).length,0);
});
test('host details outside the confirmed region or GPU alternatives cannot become acquisition candidates',async t=>{
 const f=await provisionFixture(t),a=await f.start('alice');await f.login(a.request);
 f.state.gpuTypes=[{gpu_name:'RTX 4090',gpu_series_type:'NVIDIA-Ada'},{gpu_name:'A100',gpu_series_type:'NVIDIA-Ampere'}];
 for(const detail of [{region_sign:'east-B'},{gpu_name:'A100'}]){
  f.state.machineDetails={'123':detail};
  const plan=await a.request({op:'task-prepare',policy});assert.equal(plan.candidate,null,'host details must stay within the selected region and GPU alternatives');
 }
 assert.equal(f.seen.filter(q=>q.path.endsWith('/create/payg')).length,0);
});
test('a confirmed minimum-total acquisition submits the derived disk once and keeps the original minimum policy',async t=>{
 const f=await provisionFixture(t),a=await f.start('alice');await f.login(a.request);const {dataDiskGB,...minimum}=policy;
 const p=await a.request({op:'task-prepare',policy:{...minimum,minDataDiskGB:70}});assert.equal(p.policy.minDataDiskGB,70);assert.equal(Object.hasOwn(p.policy,'dataDiskGB'),false);
 const task=await a.request({op:'task-start',planId:p.planId,confirmed:true});
 const result=await until(async()=>{const r=await a.request({op:'task-info',taskId:task.id});return r.state==='completed'&&r;});
 const writes=f.seen.filter(q=>q.path.endsWith('/create/payg'));assert.equal(writes.length,1);assert.equal(writes[0].body.instance_info.expand_data_disk,20*GB);assert.equal(result.candidate.totalDataDiskGB,70);
});
test('host-specific disk and rental constraints are reported distinctly from invalid user parameters',async t=>{
 const f=await provisionFixture(t),a=await f.start('alice');await f.login(a.request);
 await assert.rejects(a.request({op:'provision-prepare',mode:'create',args:{...creation,dataDiskGB:501}}),{code:'DATA_DISK_UNAVAILABLE'});
 f.state.machines[0].rent_mode='Base4';f.state.machines[0].gpu_idle_num=4;
 await assert.rejects(a.request({op:'provision-prepare',mode:'create',args:creation}),{code:'HOST_CONFIG_MISMATCH'});
 await assert.rejects(a.request({op:'task-prepare',policy:{...policy,name:'x'.repeat(33)}}),{code:'INVALID_REQUEST'});
 assert.equal(f.seen.filter(q=>q.path.endsWith('/create/payg')).length,0);
});
test('malformed host disk metadata stops acquisition instead of silently selecting another host',async t=>{
 const f=await provisionFixture(t),a=await f.start('alice');await f.login(a.request);const base=f.state.machines[0];
 f.state.machines=[{...base,max_data_disk_expand_size:null},{...base,machine_id:124}];
 await assert.rejects(a.request({op:'task-prepare',policy}),{code:'SCHEMA_CHANGED'});assert.equal(f.seen.filter(q=>q.path.endsWith('/create/payg')).length,0);
});
test('machine listings expose expansion capacity so clients can show achievable total disk',async t=>{
 const f=await provisionFixture(t),a=await f.start('alice');await f.login(a.request);const machines=await a.request({op:'machines',args:{regionSigns:['west-A']}});
 assert.equal(machines[0].max_data_disk_expand_size,500*GB);assert.doesNotMatch(JSON.stringify(machines),/must-not-leak/);
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
