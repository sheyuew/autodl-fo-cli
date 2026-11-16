import test from 'node:test';
import assert from 'node:assert/strict';
import {RemoteClient} from '../remote-client.mjs';
import {WebClient} from '../web-client.mjs';
import {instanceMenu} from '../instance-menu.mjs';
import {provisionFixture,until} from './provision-service-fixture.mjs';
import {runTerminal} from './terminal-utils.mjs';
let menus;try{menus=await import('../provision-menu.mjs');}catch(error){if(error.code!=='ERR_MODULE_NOT_FOUND')throw error;}
async function setup(t){const fixture=await provisionFixture(t),service=await fixture.start('menu');await fixture.login(service.request);const client=new RemoteClient({request:service.request});await client.restore();return {...fixture,client};}
const captured=new WeakSet();
function ui(t,answers,confirmed=true){
 const output=[],errors=[],prompts=[];let confirmations=0;
 const oldLog=console.log,oldTable=console.table,oldDir=console.dir;
 console.log=(...v)=>output.push(v.join(' '));console.table=v=>output.push(JSON.stringify(v));console.dir=v=>output.push(JSON.stringify(v));
 if(!captured.has(t)){captured.add(t);t.after(()=>{console.log=oldLog;console.table=oldTable;console.dir=oldDir;});}
 return {output,errors,prompts,get confirmations(){return confirmations;},io:{ask:async prompt=>{prompts.push(prompt);return answers.length?answers.shift():'q';},confirm:async()=>{confirmations++;return confirmed;},showError:error=>errors.push(error)}};
}
const createInputs=['1','1','1','1','1','1','1','10','new run'];
const cloneInputs=['2','1','1','1','1','1','yes','10','clone run'];
test('creation menu shows full configuration and live costs, no cancels and yes submits once',async t=>{
 assert.equal(typeof menus?.provisionMenu,'function','provisioning menu is not implemented');
 const f=await setup(t),no=ui(t,[...createInputs],false);await menus.provisionMenu(f.client,no.io);
 assert.equal(no.confirmations,1);assert.equal(no.errors.length,0);assert.equal(f.seen.filter(x=>x.path.endsWith('/create/payg')).length,0);
 assert.ok(!no.prompts.some(prompt=>prompt.includes('最低显存')));
 assert.match(no.output.join('\n'),/50/);assert.match(no.output.join('\n'),/2\.220/);assert.match(no.output.join('\n'),/0\.480/);
 const yes=ui(t,[...createInputs],true);await menus.provisionMenu(f.client,yes.io);assert.equal(yes.errors.length,0);
 const writes=f.seen.filter(x=>x.path.endsWith('/create/payg'));assert.equal(writes.length,1);assert.equal(writes[0].body.instance_info.base_image_uuid,'base-1');assert.equal(writes[0].body.instance_info.expand_data_disk,10*1024**3);assert.equal(writes[0].body.instance_info.instance_name,'new run');
});
test('clone menu selects an owned stopped source and explicitly asks whether to copy its data',async t=>{
 assert.equal(typeof menus?.provisionMenu,'function');const f=await setup(t),u=ui(t,[...cloneInputs]);
 await menus.provisionMenu(f.client,u.io);assert.equal(u.errors.length,0);const write=f.seen.find(x=>x.path.endsWith('/clone/payg'));
 assert.ok(write);assert.equal(write.body.instance_uuid,'source');assert.equal(write.body.instance_info.copy_data_disk_after_clone,true);assert.match(u.output.join('\n'),/source/);assert.equal(u.confirmations,1);
});
test('standalone HTTP client can preview a private-image creation and cancel without a service',async t=>{
 assert.equal(typeof menus?.provisionMenu,'function');const f=await provisionFixture(t),u=ui(t,['1','1','1','1','1','2','1','0','private run'],false);
 const client=new WebClient({session:{token:'fixture',user:{id:1,sub_name:'alice@team'}},baseUrl:f.baseUrl});
 await menus.provisionMenu(client,u.io);assert.equal(u.errors.length,0);assert.equal(u.confirmations,1);assert.match(u.output.join('\n'),/private-1/);assert.equal(f.seen.filter(x=>x.path.endsWith('/create/payg')).length,0);
});
test('data disk menu displays expansion-only daily pricing and confirms the capacity change safely',async t=>{
 const f=await setup(t),u=ui(t,['1','12','20','q']);await instanceMenu(f.client,u.io);
 assert.equal(u.errors.length,0);assert.equal(u.confirmations,1);assert.match(u.output.join('\n'),/60.*70|10.*20/);assert.match(u.output.join('\n'),/0\.960/);
 const writes=f.seen.filter(x=>x.path.endsWith('/data_disk/change'));assert.equal(writes.length,1);assert.equal(writes[0].body.change_size,10*1024**3);
});
test('automatic power-on needs an hourly budget, time and interval before yes starts one background task',async t=>{
 assert.equal(typeof menus?.resourceMenu,'function');const f=await setup(t),u=ui(t,['1','1','1','0','3','1','10','q']);
 await menus.resourceMenu(f.client,u.io);assert.equal(u.errors.length,0);assert.equal(u.confirmations,1);const tasks=await f.client.tasks();assert.equal(tasks.length,1);
 assert.equal(tasks[0].policy.mode,'powerOn');assert.equal(tasks[0].policy.maxHourly,3);assert.equal(tasks[0].policy.maxMinutes,1);assert.equal(tasks[0].policy.intervalSeconds,10);
 assert.ok(!u.prompts.some(prompt=>prompt.includes('最低显存')));
 assert.match(u.output.join('\n'),/不.*自动关机|不会.*关机/);await until(()=>f.state.sourceStatus==='running');
});
test('automatic create and clone policies preserve selected conditions and no starts no task',async t=>{
 assert.equal(typeof menus?.resourceMenu,'function');const f=await setup(t);
 for(const [mode,inputs] of [['create',['2','1','1','1','0','1','1','1','10','new run']],['clone',['3','1','1','1','0','1','no','1','10','clone run']]]){
  const u=ui(t,['1',...inputs,'3','1','10','q'],false);await menus.resourceMenu(f.client,u.io);assert.equal(u.errors.length,0);assert.equal(u.confirmations,1);
  assert.match(u.output.join('\n'),new RegExp(mode));assert.equal((await f.client.tasks()).length,0);
  const policy=u.output.map(line=>{try{return JSON.parse(line);}catch{return null;}}).find(value=>value?.mode===mode&&value.regionSigns);
  assert.ok(!Object.hasOwn(policy,'minGpuMemoryGB'));
 }
});
test('automatic creation allows the platform default name without persisting an invalid empty policy name',async t=>{
 assert.equal(typeof menus?.resourceMenu,'function');const f=await setup(t),u=ui(t,['1','2','1','1','1','0','1','1','1','10','','3','1','10','q'],false);
 await menus.resourceMenu(f.client,u.io);assert.equal(u.errors.length,0,u.errors.map(e=>e.code+':'+e.message).join(' '));assert.equal(u.confirmations,1);assert.equal((await f.client.tasks()).length,0);
});
test('automatic minimum-total disk selection reaches HTTP preview with only the required paid capacity',async t=>{
 const f=await setup(t),u=ui(t,['1','2','1','1','1','0','1','1','2','70','Minimum disk','3','1','10','q'],false);
 await menus.resourceMenu(f.client,u.io);
 assert.equal(u.errors.length,0,u.errors.map(e=>e.code+':'+e.message).join(' '));assert.equal(u.confirmations,1);
 const policy=u.output.map(line=>{try{return JSON.parse(line);}catch{return null;}}).find(value=>value?.mode==='create'&&value.regionSigns);
 assert.equal(policy?.minDataDiskGB,70);assert.ok(!Object.hasOwn(policy,'dataDiskGB'));
 const quote=f.seen.find(row=>row.path.endsWith('/order/price/preview'));
 assert.equal(quote?.body.expand_data_disk,20*1024**3);assert.equal((await f.client.tasks()).length,0);
 assert.equal(f.seen.filter(row=>row.path.endsWith('/create/payg')).length,0);
});
test('task lists, details and stopping use the same account and require final confirmation',async t=>{
 assert.equal(typeof menus?.resourceMenu,'function');const f=await setup(t);f.state.idle=0;
 const p=await f.client.prepareTask({mode:'create',regionSigns:['west-A'],gpuNames:['RTX 4090'],gpuCount:1,imageUuid:'base-1',dataDiskGB:10,maxHourly:3,maxMinutes:1,intervalSeconds:10});
 const task=await f.client.startTask(p.planId,{confirmed:true}),u=ui(t,['2','3','1','4','1','q']);
 await menus.resourceMenu(f.client,u.io);assert.equal(u.errors.length,0);assert.equal(u.confirmations,1);assert.equal((await f.client.taskInfo(task.id)).state,'cancelled');assert.match(u.output.join('\n'),new RegExp(task.id));
});
test('standalone client refuses to promise a background task service it does not own',async t=>{
 assert.equal(typeof menus?.resourceMenu,'function');const f=await provisionFixture(t),u=ui(t,[]),client=new WebClient({session:{token:'fixture',user:{id:1,sub_name:'alice@team'}},baseUrl:f.baseUrl});
 await menus.resourceMenu(client,u.io);assert.equal(u.confirmations,0);assert.match(u.output.join('\n'),/bash.*fo|默认.*本地/);assert.equal(f.seen.length,0);
});
test('native terminal exposes provisioning and task menus and returns without browser activity',{timeout:15000},async t=>{
 const f=await provisionFixture(t);const result=await runTerminal({baseUrl:f.baseUrl,steps:[{wait:'AutoDL 子账号：',send:'alice@team\n'},{wait:'密码（不回显）：',send:'fixture-password\n'},{wait:'选择操作',send:'7\n'},{wait:'新建/克隆模式',send:'q\n'},{wait:'选择操作',count:2,send:'8\n'},{wait:'选择操作',count:3,send:'q\n'}]},t);
 assert.equal(result.code,0,result.error);assert.match(result.output,/自动抢卡/);assert.match(result.output,/默认.*本地|bash.*fo/);assert.ok(!result.output.includes('fixture-password'));
});
