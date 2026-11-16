import test from 'node:test';
import assert from 'node:assert/strict';
import {resourceMenu} from '../provision-menu.mjs';

function menuBoundary(t,answers,{confirmed=true,cloneOnly=false}={}){
 const output=[],errors=[],prompts=[],policies=[],started=[];
 let confirmations=0;
 const oldLog=console.log,oldDir=console.dir;
 console.log=(...values)=>output.push(values.join(' '));console.dir=value=>output.push(JSON.stringify(value));
 t.after(()=>{console.log=oldLog;console.dir=oldDir;});
 const client={
  regions:async()=>[{region_name:'West',region_sign:'west-A',visible:'all',used_for:'all'},{region_name:'East',region_sign:'east-B',visible:'all',used_for:'all'},{region_name:'Hidden',region_sign:'hidden',visible:'none',used_for:'all'}],
  gpuTypes:async()=>[{gpu_name:'RTX 4090',chip_corp:'nvidia'},{gpu_name:'A100',chip_corp:'nvidia'},{gpu_name:'CPU',chip_corp:'cpu'}],
  machines:async()=>{assert.equal(cloneOnly,false,'clone acquisition must not require a reference host');return [{machine_id:123,region_sign:'west-A',gpu_name:'RTX 4090',gpu_idle_num:0,max_instance_disk_size:50*1024**3}];},
  provisionCatalog:async conditions=>{assert.equal(cloneOnly,false,'clone acquisition must not require an image catalog');assert.equal(conditions.machineId,123);return {images:[{imageUuid:'base-1',imageType:'base',name:'PyTorch',cudaVersion:'12.1'}]};},
  instances:async()=>[{uuid:'source',name:'Source',status:'shutdown',charge_type:'payg'}],
  prepareTask:async policy=>{policies.push(structuredClone(policy));return {planId:'plan-1',policy:structuredClone(policy)};},
  startTask:async(id,options)=>{started.push({id,...options});return {id:'task-1',state:'waiting'};},
  tasks:async()=>[],taskInfo:async()=>{},cancelTask:async()=>{}
 };
 return {client,output,errors,prompts,policies,started,get confirmations(){return confirmations;},io:{
  ask:async prompt=>{prompts.push(prompt);return answers.length?answers.shift():'q';},
  confirm:async()=>{confirmations++;return confirmed;},showError:error=>errors.push(error)
 }};
}

test('automatic creation accepts validated region and GPU alternatives, deduplicates them and asks for no host',async t=>{
 const b=menuBoundary(t,['1','2','0','2,1,2','99','2,1,2','2','1','1','2','0','1000001','200','Cross range','5','60','30','q']);
 await resourceMenu(b.client,b.io);
 assert.deepEqual(b.errors,[]);
 assert.deepEqual(b.policies,[{mode:'create',regionSigns:['east-B','west-A'],gpuNames:['A100','RTX 4090'],gpuCount:2,imageType:'base',imageUuid:'base-1',minDataDiskGB:200,name:'Cross range',maxHourly:5,maxMinutes:60,intervalSeconds:30,maxAttempts:120}]);
 assert.equal(b.prompts.filter(p=>p.startsWith('选择地区编号')).length,2);
 assert.equal(b.prompts.filter(p=>p.startsWith('选择 GPU 型号编号')).length,2);
 assert.ok(!b.prompts.some(p=>p.includes('选择主机')));
 assert.equal(b.confirmations,1);assert.deepEqual(b.started,[{id:'plan-1',confirmed:true}]);
 assert.match(b.output.join('\n'),/任一|或者|OR/);assert.match(b.output.join('\n'),/逐.*主机|各.*主机/);
 assert.match(b.output.join('\n'),/仅.*一次|只.*一次/);
});

test('automatic cloning supports all displayed alternatives with fixed paid capacity and no reference host',async t=>{
 const b=menuBoundary(t,['1','3','all','a','1','1','yes','1','64','Clone','3','1','10','q'],{confirmed:false,cloneOnly:true});
 await resourceMenu(b.client,b.io);
 assert.deepEqual(b.errors,[]);
 assert.deepEqual(b.policies,[{mode:'clone',regionSigns:['west-A','east-B'],gpuNames:['RTX 4090','A100'],gpuCount:1,sourceInstanceUuid:'source',copyDataDisk:true,dataDiskGB:64,name:'Clone',maxHourly:3,maxMinutes:1,intervalSeconds:10,maxAttempts:6}]);
 assert.equal(b.confirmations,1);assert.deepEqual(b.started,[]);
 assert.ok(!b.prompts.some(p=>p.includes('选择主机')));
});

test('cancelling automatic disk selection creates no task plan or confirmation',async t=>{
 const b=menuBoundary(t,['1','3','全选','全选','1','1','no','q','q'],{cloneOnly:true});
 await resourceMenu(b.client,b.io);
 assert.deepEqual(b.errors,[]);assert.deepEqual(b.policies,[]);assert.deepEqual(b.started,[]);assert.equal(b.confirmations,0);
});
