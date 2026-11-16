import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,stat,readdir,rm,rename} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

const loaded=await import('../resource-tasks.mjs').catch(error=>{if(error.code==='ERR_MODULE_NOT_FOUND')return {};throw error;});
const error=code=>Object.assign(new Error('provider detail with token=do-not-persist'),{code});
const policy={mode:'create',name:'training',regionSigns:['west'],gpuNames:['RTX 4090'],gpuCount:1,imageUuid:'image-1',driverVersion:'550',dataDiskGB:100,maxHourly:3,intervalSeconds:10,maxMinutes:5,maxAttempts:3};
class Clock {
 now=Date.parse('2026-11-16T00:00:00Z');next=1;jobs=new Map();
 setTimeout=(fn,ms)=>{const id=this.next++;this.jobs.set(id,{fn,at:this.now+ms});return id;};
 clearTimeout=id=>this.jobs.delete(id);
 async advance(ms=0){const end=this.now+ms;for(;;){const next=[...this.jobs.entries()].filter(([,v])=>v.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!next)break;this.jobs.delete(next[0]);this.now=next[1].at;await next[1].fn();}this.now=end;}
}
async function fixture(t,options={}){
 assert.equal(typeof loaded.ResourceTasks,'function','Resource task engine is not implemented');
 const state=await mkdtemp(join(tmpdir(),'fo-resource-task-')),clock=new Clock(),events=[];
 const engine=new loaded.ResourceTasks({state,now:()=>clock.now,timers:clock,prepareCandidate:async()=>({planId:'ephemeral-plan',quote:{totalHourly:2}}),executeCandidate:async()=>({accepted:true,instanceUuid:'new-instance'}),notify:async event=>events.push(event),...options});
 await engine.init();t.after(async()=>{await engine.close();await rm(state,{recursive:true,force:true});});return {engine,state,clock,events};
}
async function start(engine,value=policy){const plan=await engine.prepare(value);return engine.start(plan.planId,{confirmed:true});}

test('a prepared budget requires one-use confirmation and fresh pricing before any submission',async t=>{
 let reads=0,submits=0;const f=await fixture(t,{prepareCandidate:async p=>{reads++;assert.equal(p.systemDiskGB,0);return {planId:'plan-'+reads,quote:{totalHourly:2}};},executeCandidate:async plan=>{submits++;assert.equal(plan.planId,'plan-2');return {accepted:true,instanceUuid:'new-instance'};}});
 const plan=await f.engine.prepare(policy);assert.equal(reads,1);assert.equal(submits,0);assert.equal(plan.oneSuccessOnly,true);assert.equal(plan.policy.systemDiskGB,0);
 await assert.rejects(()=>f.engine.start(plan.planId,{confirmed:false}),{code:'CONFIRMATION_REQUIRED'});
 const task=await f.engine.start(plan.planId,{confirmed:true});await assert.rejects(()=>f.engine.start(plan.planId,{confirmed:true}),{code:'PLAN_EXPIRED'});
 assert.equal(f.engine.active,true);await f.clock.advance();assert.equal(submits,1);assert.equal(f.engine.info(task.id).state,'submitted');assert.equal(f.engine.active,false);
 await f.clock.advance(60000);assert.equal(submits,1);assert.equal(f.events[0].state,'submitted');assert.ok(!f.events[0].message.includes('成功'));
});

test('no stock and over-budget stock only poll, then a fresh affordable candidate is submitted once',async t=>{
 const offers=[null,null,{quote:{totalHourly:4}},{quote:{totalHourly:2}}];let submits=0;
 const f=await fixture(t,{prepareCandidate:async()=>offers.shift(),executeCandidate:async()=>{submits++;return {accepted:true};}}),task=await start(f.engine,{...policy,maxAttempts:4});
 await f.clock.advance();assert.equal(f.engine.info(task.id).state,'waiting');assert.equal(submits,0);
 await f.clock.advance(10000);assert.equal(f.engine.info(task.id).errorCode,'PRICE_LIMIT');assert.equal(submits,0);
 await f.clock.advance(10000);assert.equal(f.engine.info(task.id).state,'submitted');assert.equal(submits,1);
});

test('host disk or configuration changes before submission wait for another fresh candidate',async t=>{
 for(const code of ['DATA_DISK_UNAVAILABLE','HOST_CONFIG_MISMATCH','PLAN_CHANGED']){
  let attempts=0,accepted=0;
  const f=await fixture(t,{executeCandidate:async()=>{if(++attempts===1)throw error(code);accepted++;return {accepted:true,instanceUuid:'new-instance'};}}),task=await start(f.engine);
  await f.clock.advance();assert.equal(f.engine.info(task.id).state,'waiting',code);assert.equal(f.engine.info(task.id).errorCode,code);assert.equal(accepted,0);
  await f.clock.advance(10000);assert.equal(f.engine.info(task.id).state,'submitted');assert.equal(accepted,1);
  await f.clock.advance(60000);assert.equal(accepted,1);
 }
});

test('policy validation rejects missing budget, ambiguous provisioning, secrets and system disk expansion',async t=>{
 let reads=0;const f=await fixture(t,{prepareCandidate:async()=>{reads++;return null;}});
 for(const change of [{maxHourly:0},{regionSigns:[]},{gpuNames:[]},{gpuCount:0},{dataDiskGB:undefined},{intervalSeconds:9},{maxMinutes:1441},{maxAttempts:10001},{password:'secret'},{mode:'clone',sourceInstanceUuid:''}])await assert.rejects(()=>f.engine.prepare({...policy,...change}),{code:'INVALID_REQUEST'});
 await assert.rejects(()=>f.engine.prepare({...policy,systemDiskGB:50}),{code:'UNSUPPORTED_OPERATION'});
 assert.equal(reads,0);const plan=await f.engine.prepare({mode:'powerOn',instanceUuid:'existing',maxHourly:2});assert.equal(plan.policy.instanceUuid,'existing');
});

test('minimum total disk consent retains its meaning through fresh candidate checks and stored results',async t=>{
 const {dataDiskGB,...base}=policy;let reads=0;
 const f=await fixture(t,{prepareCandidate:async p=>{
  reads++;assert.equal(p.minDataDiskGB,900);assert.equal(Object.hasOwn(p,'dataDiskGB'),false);
  return {machineId:456,gpuCount:1,freeDataDiskGB:100,dataDiskGB:800,totalDataDiskGB:900,quote:{totalHourly:2.9}};
 }});
 const plan=await f.engine.prepare({...base,minDataDiskGB:900});
 assert.equal(plan.policy.minDataDiskGB,900);assert.equal(plan.candidate.freeDataDiskGB,100);assert.equal(plan.candidate.dataDiskGB,800);assert.equal(plan.candidate.totalDataDiskGB,900);
 const task=await f.engine.start(plan.planId,{confirmed:true});await f.clock.advance();
 assert.equal(reads,2);const stored=JSON.parse(await readFile(join(f.state,'resource-tasks.json'),'utf8')).tasks.find(r=>r.id===task.id);
 assert.equal(stored.policy.minDataDiskGB,900);assert.equal(stored.candidate.totalDataDiskGB,900);
});

test('ambiguous or invalid total disk requirements fail before querying a provider',async t=>{
 let reads=0;const f=await fixture(t,{prepareCandidate:async()=>{reads++;return null;}}),{dataDiskGB,...base}=policy;
 for(const value of [{...policy,minDataDiskGB:900},...[-1,0,1.5,'900',1000001].map(minDataDiskGB=>({...base,minDataDiskGB}))]){
  await assert.rejects(()=>f.engine.prepare(value),{code:'INVALID_REQUEST'});
 }
 await assert.rejects(()=>f.engine.prepare({mode:'powerOn',instanceUuid:'existing',maxHourly:3,minDataDiskGB:900}),{code:'UNSUPPORTED_OPERATION'});
 assert.equal(reads,0);
});

test('an invalid instance name is rejected even when no host currently fits the disk requirement',async t=>{
 let reads=0;const f=await fixture(t,{prepareCandidate:async()=>{reads++;return null;}});
 for(const name of ['a'.repeat(33),'测'.repeat(33),'train\x7f'])await assert.rejects(()=>f.engine.prepare({...policy,name}),{code:'INVALID_REQUEST'});
 assert.equal(reads,0);
});

test('multiple region and GPU alternatives are preserved and deduplicated without changing the caller',async t=>{
 const f=await fixture(t,{prepareCandidate:async()=>null}),input={...policy,regionSigns:['west','east','west'],gpuNames:['RTX 4090','RTX 5090','RTX 4090']};
 const plan=await f.engine.prepare(input);
 assert.deepEqual(plan.policy.regionSigns,['west','east']);assert.deepEqual(plan.policy.gpuNames,['RTX 4090','RTX 5090']);assert.equal(input.regionSigns.length,3);assert.equal(input.gpuNames.length,3);
});

test('an expired confirmation and a duplicate active power-on cannot authorize another task',async t=>{
 const f=await fixture(t,{prepareCandidate:async()=>null}),p={mode:'powerOn',instanceUuid:'existing',maxHourly:2};
 const old=await f.engine.prepare(p);await f.clock.advance(120001);await assert.rejects(()=>f.engine.start(old.planId,{confirmed:true}),{code:'PLAN_EXPIRED'});
 await start(f.engine,p);const duplicate=await f.engine.prepare({...p,maxHourly:3});await assert.rejects(()=>f.engine.start(duplicate.planId,{confirmed:true}),{code:'TASK_CONFLICT'});assert.equal(f.engine.list().length,1);
});

test('submitting is durable before execution and a lost submission response is never retried',async t=>{
 let writes=0;let statePath;const f=await fixture(t,{executeCandidate:async()=>{writes++;const persisted=JSON.parse(await readFile(join(statePath,'resource-tasks.json'),'utf8'));assert.equal(persisted.tasks[0].state,'submitting');throw error('NETWORK');}});statePath=f.state;
 const task=await start(f.engine);await f.clock.advance();assert.equal(f.engine.info(task.id).state,'uncertain');assert.equal(writes,1);await f.clock.advance(60000);assert.equal(writes,1);
 const stored=await readFile(join(f.state,'resource-tasks.json'),'utf8');assert.ok(!stored.includes('do-not-persist'));assert.ok(!stored.includes('ephemeral-plan'));assert.equal((await stat(join(f.state,'resource-tasks.json'))).mode&0o777,0o600);
});

test('permission, quota and expired login stop permanently rather than retrying',async t=>{
 for(const code of ['PERMISSION_DENIED','QUOTA_EXCEEDED','LOGIN_REQUIRED']){
  let attempts=0;const f=await fixture(t,{prepareCandidate:async()=>{if(++attempts===1)return null;throw error(code);}}),task=await start(f.engine);
  await f.clock.advance();assert.equal(f.engine.info(task.id).state,'failed');assert.equal(f.engine.info(task.id).errorCode,code);await f.clock.advance(120000);assert.equal(attempts,2);
 }
});

test('rate limiting honors retry-after and never overlaps candidate reads',async t=>{
 let reads=0,active=0,maxActive=0;const f=await fixture(t,{prepareCandidate:async()=>{reads++;active++;maxActive=Math.max(maxActive,active);try{if(reads===2)throw Object.assign(error('RATE_LIMITED'),{retryAfterSeconds:45});return null;}finally{active--;}}});
 const task=await start(f.engine);await f.clock.advance();await f.clock.advance(44000);assert.equal(reads,2);await f.clock.advance(1000);assert.equal(reads,3);assert.equal(maxActive,1);assert.equal(f.engine.info(task.id).state,'waiting');
});

test('attempt and time bounds expire monitoring without a submission',async t=>{
 const a=await fixture(t,{prepareCandidate:async()=>null}),task=await start(a.engine,{...policy,maxAttempts:1});await a.clock.advance();assert.equal(a.engine.info(task.id).state,'expired');assert.equal(a.engine.info(task.id).errorCode,'ATTEMPTS_EXHAUSTED');
 const b=await fixture(t,{prepareCandidate:async()=>null}),timed=await start(b.engine,{...policy,maxMinutes:0.01});await b.clock.advance();await b.clock.advance(600);assert.equal(b.engine.info(timed.id).state,'expired');assert.equal(b.engine.info(timed.id).errorCode,'TIME_EXPIRED');
});

test('cancel requires confirmation and prevents a waiting task from submitting',async t=>{
 let submits=0;const f=await fixture(t,{executeCandidate:async()=>{submits++;return {accepted:true};}}),task=await start(f.engine);
 await assert.rejects(()=>f.engine.cancel(task.id,{confirmed:false}),{code:'CONFIRMATION_REQUIRED'});await f.engine.cancel(task.id,{confirmed:true});await f.clock.advance(30000);
 assert.equal(f.engine.info(task.id).state,'cancelled');assert.equal(submits,0);assert.equal(f.engine.active,false);
});

test('accepted requests only complete when observation confirms a running instance',async t=>{
 let submits=0,observations=0;const f=await fixture(t,{executeCandidate:async()=>{submits++;return {accepted:true,instanceUuid:'new-instance'};},observeResult:async result=>{assert.equal(result.instanceUuid,'new-instance');return {status:++observations===1?'pending':'running',instanceUuid:'new-instance'};}}),task=await start(f.engine);
 await f.clock.advance();assert.equal(f.engine.info(task.id).state,'verifying');assert.equal(f.engine.active,true);assert.equal(f.events.length,0);
 await f.clock.advance(10000);assert.equal(f.engine.info(task.id).state,'completed');assert.equal(submits,1);assert.equal(f.events[0].state,'completed');
});

test('observation failure never repeats a paid request and expires separately from allocation',async t=>{
 let submits=0;const f=await fixture(t,{executeCandidate:async()=>{submits++;return {accepted:true};},observeResult:async()=>{throw error('NETWORK');}}),task=await start(f.engine,{...policy,maxAttempts:1,maxMinutes:0.02});
 await f.clock.advance();assert.equal(f.engine.info(task.id).state,'verifying');await f.clock.advance(10000);assert.equal(f.engine.info(task.id).state,'expired');assert.equal(f.engine.info(task.id).submitted,true);assert.equal(submits,1);
});

test('restart pauses running records and marks in-flight submissions uncertain without provider calls',async t=>{
 const f=await fixture(t,{prepareCandidate:async()=>null}),first=await start(f.engine);const stored=JSON.parse(await readFile(join(f.state,'resource-tasks.json'),'utf8'));
 stored.tasks.push({...stored.tasks[0],id:'was-submitting',state:'submitting',policy:{...stored.tasks[0].policy,instanceUuid:'other'}});await f.engine.close();await writeFile(join(f.state,'resource-tasks.json'),JSON.stringify(stored));
 let calls=0;const recovered=new loaded.ResourceTasks({state:f.state,prepareCandidate:async()=>{calls++;return null;},executeCandidate:async()=>{calls++;return {accepted:true};}});await recovered.init();
 assert.equal(recovered.info(first.id).state,'paused');assert.equal(recovered.info('was-submitting').state,'uncertain');assert.equal(recovered.active,false);assert.equal(calls,0);
 const files=await readdir(f.state);assert.deepEqual(files,['resource-tasks.json']);await recovered.close();
});

test('private image choice and clone data-copy scope survive confirmation without implicit data copying',async t=>{
 const f=await fixture(t,{prepareCandidate:async()=>null});
 const privatePlan=await f.engine.prepare({...policy,imageType:'private'});assert.equal(privatePlan.policy.imageType,'private');
 await assert.rejects(()=>f.engine.prepare({...policy,imageType:'unknown'}),{code:'INVALID_REQUEST'});
 const cloned=await f.engine.prepare({...policy,mode:'clone',sourceInstanceUuid:'source-1'});assert.equal(cloned.policy.copyDataDisk,false);assert.equal(cloned.policy.imageType,'base');
});

test('cancelling during a candidate query blocks payment after the pending read finishes',async t=>{
 let entered,release,submits=0,calls=0;const inside=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve);
 const f=await fixture(t,{prepareCandidate:async()=>{if(++calls===2){entered();await gate;}return {quote:{totalHourly:2}};},executeCandidate:async()=>{submits++;return {accepted:true};}}),task=await start(f.engine);
 const tick=f.clock.advance();await inside;const cancellation=f.engine.cancel(task.id,{confirmed:true});release();await Promise.all([tick,cancellation]);
 assert.equal(f.engine.info(task.id).state,'cancelled');assert.equal(submits,0);
});

test('cancelling while payment is in flight preserves acceptance and never claims remote cancellation',async t=>{
 let entered,release,submits=0;const inside=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve);
 const f=await fixture(t,{executeCandidate:async()=>{submits++;entered();await gate;return {accepted:true,instanceUuid:'already-submitted'};}}),task=await start(f.engine);
 const tick=f.clock.advance();await inside;const cancellation=f.engine.cancel(task.id,{confirmed:true});release();await Promise.all([tick,cancellation]);
 const result=f.engine.info(task.id);assert.equal(result.state,'cancelled');assert.equal(result.submitted,true);assert.equal(result.instanceUuid,'already-submitted');assert.equal(submits,1);assert.ok(f.events[0].message.includes('已提交'));
});

test('independent monitoring tasks serialize provider calls even when both timers fire together',async t=>{
 let calls=0,active=0,maxActive=0,entered,release;const inside=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve);
 const f=await fixture(t,{prepareCandidate:async()=>{calls++;if(calls>2){active++;maxActive=Math.max(maxActive,active);if(calls===3){entered();await gate;}active--;}return null;}});
 await start(f.engine,{...policy,name:'one'});await start(f.engine,{...policy,name:'two'});const jobs=[...f.clock.jobs.values()];f.clock.jobs.clear();const first=jobs[0].fn(),second=jobs[1].fn();await inside;assert.equal(calls,3);release();await Promise.all([first,second]);assert.equal(calls,4);assert.equal(maxActive,1);
});

test('failure to persist submitting prevents payment and reports a paused local task',async t=>{
 let state,submits=0,calls=0;const f=await fixture(t,{prepareCandidate:async()=>{if(++calls===2){await rename(state,state+'.saved');await writeFile(state,'blocked');}return {quote:{totalHourly:2}};},executeCandidate:async()=>{submits++;return {accepted:true};}});state=f.state;
 const task=await start(f.engine);await f.clock.advance();assert.equal(submits,0);assert.equal(f.engine.info(task.id).state,'paused');assert.equal(f.engine.info(task.id).errorCode,'STATE_WRITE_FAILED');
 await rm(state);await rename(state+'.saved',state);assert.equal(f.events[0]?.errorCode,'STATE_WRITE_FAILED');
});

test('explicit business rejections fail without misreporting an uncertain purchase',async t=>{
 for(const stage of ['prepare','execute']){
  let calls=0;const f=await fixture(t,{prepareCandidate:async()=>{if(stage==='prepare'&&++calls>1)throw error('API_ERROR');return {quote:{totalHourly:2}};},executeCandidate:async()=>{throw error('API_ERROR');}}),task=await start(f.engine);
  await f.clock.advance();assert.equal(f.engine.info(task.id).state,'failed');assert.equal(f.engine.info(task.id).errorCode,'API_ERROR');
 }
});

test('invalid images and disk configuration stop polling and require a new policy',async t=>{
 for(const code of ['IMAGE_REQUIRED','IMAGE_INCOMPATIBLE','DISK_LIMIT','DISK_SIZE_REQUIRED']){
  let calls=0;const f=await fixture(t,{prepareCandidate:async()=>{if(++calls>1)throw error(code);return null;}}),task=await start(f.engine);
  await f.clock.advance();assert.equal(f.engine.info(task.id).state,'failed');assert.equal(f.engine.info(task.id).errorCode,code);await f.clock.advance(60000);assert.equal(calls,2);
 }
});

test('lost login or permissions after submission pause observation and notify immediately',async t=>{
 for(const code of ['LOGIN_REQUIRED','PERMISSION_DENIED']){
  let reads=0;const f=await fixture(t,{observeResult:async()=>{reads++;throw error(code);}}),task=await start(f.engine);
  await f.clock.advance();assert.equal(f.engine.info(task.id).state,'paused');assert.equal(f.engine.info(task.id).submitted,true);assert.equal(f.events[0].errorCode,code);await f.clock.advance(60000);assert.equal(reads,1);
 }
});

test('candidate previews and stored history retain the complete safe quote while stripping provider credentials',async t=>{
 const quote={currency:'CNY',computeHourly:2,dataDiskDaily:.48,systemDiskDaily:0,storageDaily:.48,totalHourly:2.02,storageChargedWhileStopped:true,storagePrepaid:false};
 const f=await fixture(t,{prepareCandidate:async()=>({machineId:123,gpuName:'RTX 4090',gpuCount:1,dataDiskGB:10,quote:{...quote,token:'quote-secret'},provider_token:'candidate-secret'})}),plan=await f.engine.prepare(policy);
 assert.deepEqual(plan.candidate.quote,quote);assert.equal(plan.candidate.machineId,123);assert.ok(!JSON.stringify(plan).includes('secret'));
 const task=await f.engine.start(plan.planId,{confirmed:true});await f.clock.advance();const persisted=JSON.parse(await readFile(join(f.state,'resource-tasks.json'),'utf8'));
 assert.deepEqual(persisted.tasks.find(x=>x.id===task.id).candidate.quote,quote);assert.ok(!JSON.stringify(persisted).includes('secret'));
});

test('close or cancellation during the submitting journal write prevents the paid provider call',async t=>{
 for(const stop of ['close','cancel']){
  let reads=0,submits=0,stopWork,task,stopping;
  const stopped=new Promise(resolve=>stopping=resolve);
  const f=await fixture(t,{prepareCandidate:async()=>{
   if(++reads===2)setImmediate(()=>{stopWork=stop==='close'?f.engine.close():f.engine.cancel(task.id,{confirmed:true});stopping();});
   return {quote:{totalHourly:2}};
  },executeCandidate:async()=>{submits++;return {accepted:true};}});
  task=await start(f.engine);const tick=f.clock.advance();await stopped;await Promise.all([tick,stopWork]);
  assert.equal(submits,0,stop+' must stop before the journalled provider submission begins');assert.equal(f.engine.active,false);
 }
});

test('a deadline reached while writing the submission journal prevents a new paid request',async t=>{
 let reads=0,submits=0;
 const f=await fixture(t,{prepareCandidate:async()=>{if(++reads===2)setImmediate(()=>f.clock.now+=1000);return {quote:{totalHourly:2}};},executeCandidate:async()=>{submits++;return {accepted:true};}});
 const task=await start(f.engine,{...policy,maxMinutes:.01});await f.clock.advance();assert.equal(submits,0);assert.equal(f.engine.info(task.id).state,'expired');assert.equal(f.engine.info(task.id).errorCode,'TIME_EXPIRED');
});

test('the paid-boundary guard blocks close, cancellation or expiry during provider revalidation',async t=>{
 for(const stop of ['close','cancel','expire']){
  let entered,release,submits=0;const reading=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve);
  const f=await fixture(t,{executeCandidate:async(_candidate,_policy,authorize)=>{entered();await gate;authorize?.();submits++;return {accepted:true};}}),task=await start(f.engine);
  const tick=f.clock.advance();await reading;let stopped;
  if(stop==='close')stopped=f.engine.close();else if(stop==='cancel')stopped=f.engine.cancel(task.id,{confirmed:true});else f.clock.now+=300001;
  release();await Promise.all([tick,stopped]);assert.equal(submits,0,stop+' while revalidating must block the actual paid write');
  assert.equal(f.engine.info(task.id).state,{close:'paused',cancel:'cancelled',expire:'expired'}[stop]);
 }
});
