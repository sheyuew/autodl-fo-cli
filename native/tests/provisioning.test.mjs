import test from 'node:test';
import assert from 'node:assert/strict';
import {ProvisioningManager} from '../provisioning.mjs';
const GB=1024**3;
function fixture(){
 const state={machine:{machine_id:123,region_sign:'west-A',region_name:'西部',gpu_name:'RTX 4090',gpu_number:8,gpu_idle_num:4,on_line:2,max_instance_num:20,binding_instance_num:3,max_instance_disk_size:50*GB,max_data_disk_expand_size:500*GB,chip_corp:'nvidia',cpu_arch:'amd64',driver_version:'550.1',highest_cuda_version:'12.4',rent_mode:'',secret_token:'must-not-leak'},price:{payg_price:2200,data_disk_info:{data_disk_deal_daily_price:480},prepay_expand_data_disk:false},source:{uuid:'source-1',name:'source',status:'shutdown',charge_type:'payg',private_image_uuid:'private-1',expand_data_disk_size:10*GB},snapshot:{image:{image_type:'private',image_name:'Private',chip_corp:'nvidia',cpu_arch:'amd64',cuda_version:'12.1'},expand_system_disk_size:0,expand_data_disk_size:10*GB,machine_info_snapshot:{max_instance_disk_size:50*GB}},writes:[],reads:[],uncertain:false,gpuSeries:'NVIDIA-Ada'};
 const api={read:async(op)=>{assert.equal(op,'gpuTypes');return[{gpu_name:'RTX 4090',gpu_series_type:state.gpuSeries}];},instances:async()=>[structuredClone(state.source)],snapshot:async()=>structuredClone(state.snapshot),machines:async()=>[structuredClone(state.machine)],pages:async(op,args)=>{assert.equal(op,'machines');assert.equal(String(args.machine_id),'123');return [structuredClone(state.machine)];},request:async(ep,body)=>{
  state.reads.push({path:ep.path,body:structuredClone(body)});
  if(ep.path==='/api/v1/image/all')return [{label_name:'PyTorch',children:[{label_name:'2.5',children:[{label_name:'3.12',children:[{label_name:{uuid:'base-1',v:'12.1',chip_corp:'nvidia',cpu_arch:'amd64',is_desktop:false}}]}]}]}];
  if(ep.path==='/api/v1/image/private/get')return [{image_uuid:'private-1',name:'Private',cuda_v:'12.1',chip_corp:'nvidia',cpu_arch:'amd64',root_password:'must-not-leak'}];
  if(ep.path==='/api/v1/order/price/preview')return structuredClone(state.price);
  if(ep.path==='/api/v1/machine/check_machine_online')return 2;
  if(['/api/v1/order/instance/create/payg','/api/v1/order/instance/clone/payg'].includes(ep.path)){state.writes.push({path:ep.path,body:structuredClone(body)});if(state.uncertain)throw Object.assign(new Error('timeout'),{code:'NETWORK'});return 'new-instance-1';}
  throw Error(`unexpected ${ep.path}`);
 }};
 return {state,manager:new ProvisioningManager(api),api};
}
const creation={machineId:123,gpuCount:2,imageUuid:'base-1',imageType:'base',name:'new run',dataDiskGB:10};
test('catalog exposes real machine/image choices and installed drivers without credentials',async()=>{
 const {manager}=fixture();const catalog=await manager.catalog({regionSigns:['west-A'],gpuNames:['RTX 4090'],gpuCount:2,machineId:123});
 assert.equal(catalog.machines[0].machine_id,123);assert.equal(catalog.machines[0].max_data_disk_expand_size,500*GB);
 assert.equal(catalog.images.find(x=>x.imageUuid==='base-1').cudaVersion,'12.1');assert.equal(catalog.images.find(x=>x.imageUuid==='private-1').imageType,'private');assert.equal(catalog.drivers[0].driverVersion,'550.1');assert.doesNotMatch(JSON.stringify(catalog),/must-not-leak/);
});
test('create previews full hourly quote then submits only the confirmed exact native payload',async()=>{
 const {manager,state}=fixture();const plan=await manager.prepare('create',creation);
 assert.equal(state.writes.length,0);assert.equal(plan.quote.computeHourly,2.2);assert.equal(plan.quote.dataDiskDaily,.48);assert.equal(plan.quote.totalHourly,2.22);
 assert.equal(plan.configuration.freeDataDiskGB,50);assert.equal(plan.configuration.dataDiskGB,10);assert.equal(plan.body.instance_info.expand_data_disk,10*GB);assert.equal(plan.body.instance_info.base_image_uuid,'base-1');
 await assert.rejects(manager.execute(plan.id),{code:'CONFIRMATION_REQUIRED'});assert.equal(state.writes.length,0);
 const result=await manager.execute(plan.id,{confirmed:true});assert.equal(result.accepted,true);assert.equal(result.instanceUuid,'new-instance-1');assert.equal(result.state,'submitted');
 assert.equal(state.writes.length,1);assert.equal(state.writes[0].path,'/api/v1/order/instance/create/payg');assert.equal(state.writes[0].body.instance_info.req_gpu_amount,2);assert.equal(state.writes[0].body.instance_info.instance_name,'new run');assert.equal(state.writes[0].body.price_info.expand_data_disk,10*GB);await assert.rejects(manager.execute(plan.id,{confirmed:true}),{code:'PLAN_EXPIRED'});
});
test('minimum-total plans derive paid capacity from verified host details and recheck the minimum before payment',async()=>{
 const {manager,state}=fixture(),{dataDiskGB,...args}=creation;
 let plan=await manager.prepare('create',{...args,minDataDiskGB:70});assert.equal(plan.configuration.dataDiskGB,20);assert.equal(plan.configuration.totalDataDiskGB,70);assert.equal(plan.body.instance_info.expand_data_disk,20*GB);
 state.machine.max_instance_disk_size=80*GB;await assert.rejects(manager.execute(plan.id,{confirmed:true}),{code:'PLAN_CHANGED'});assert.equal(state.writes.length,0);
 plan=await manager.prepare('create',{...args,minDataDiskGB:70});assert.equal(plan.configuration.dataDiskGB,0);assert.equal(plan.configuration.totalDataDiskGB,80);assert.equal(plan.body.instance_info.expand_data_disk,0);
 await assert.rejects(manager.prepare('create',{...creation,minDataDiskGB:70}),{code:'INVALID_REQUEST'});
});
test('clone binds stopped owned source and explicitly separates copying data from copying system',async()=>{
 const {manager,state}=fixture();const plan=await manager.prepare('clone',{machineId:123,gpuCount:1,sourceInstanceUuid:'source-1',dataDiskGB:10,copyDataDisk:true,name:'clone'});
 assert.equal(plan.body.instance_uuid,'source-1');assert.equal(plan.body.instance_info.copy_data_disk_after_clone,true);assert.equal(plan.body.instance_info.keep_src_user_service_address_after_clone,false);assert.equal(plan.body.instance_info.private_image_uuid,'private-1');
 await manager.execute(plan.id,{confirmed:true});assert.equal(state.writes[0].path,'/api/v1/order/instance/clone/payg');
 state.source.status='running';await assert.rejects(manager.prepare('clone',{...creation,sourceInstanceUuid:'source-1'}),{code:'STATE_CHANGED'});
 await assert.rejects(manager.prepare('clone',{...creation,sourceInstanceUuid:'other-user-source'}),{code:'INSTANCE_REQUIRED'});
});
test('changed price or selected configuration prevents creation after confirmation',async()=>{
 const {manager,state}=fixture();let p=await manager.prepare('create',creation);state.price.payg_price=2300;
 await assert.rejects(manager.execute(p.id,{confirmed:true}),{code:'PLAN_CHANGED'});assert.equal(state.writes.length,0);
 p=await manager.prepare('create',creation);state.machine.driver_version='555.2';await assert.rejects(manager.execute(p.id,{confirmed:true}),{code:'PLAN_CHANGED'});assert.equal(state.writes.length,0);
});
test('unavailable stock, disk limits, unsupported type and incompatible image fail before writes',async()=>{
 const {manager,state}=fixture();await assert.rejects(manager.prepare('create',{...creation,dataDiskGB:501}),{code:'DATA_DISK_UNAVAILABLE'});
 await assert.rejects(manager.prepare('create',{...creation,systemDiskGB:10}),{code:'UNSUPPORTED_OPERATION'});
 await assert.rejects(manager.prepare('create',{...creation,chargeType:'monthly'}),{code:'UNSUPPORTED_OPERATION'});
 await assert.rejects(manager.prepare('create',{...creation,imageUuid:'made-up'}),{code:'IMAGE_REQUIRED'});
 state.machine.highest_cuda_version='11.8';await assert.rejects(manager.prepare('create',creation),{code:'IMAGE_INCOMPATIBLE'});
 state.machine.highest_cuda_version='12.4';state.machine.gpu_idle_num=1;await assert.rejects(manager.prepare('create',creation),{code:'NO_STOCK'});assert.equal(state.writes.length,0);
});
test('unknown submission outcome is never retried and consumes the plan',async()=>{
 const {manager,state}=fixture();const p=await manager.prepare('create',creation);state.uncertain=true;
 await assert.rejects(manager.execute(p.id,{confirmed:true}),{code:'ACTION_UNCERTAIN'});await assert.rejects(manager.execute(p.id,{confirmed:true}),{code:'PLAN_EXPIRED'});assert.equal(state.writes.length,1);
});
test('plans cannot be executed in another account manager and source changes invalidate clone',async()=>{
 const first=fixture(),second=fixture();const p=await first.manager.prepare('clone',{machineId:123,gpuCount:1,sourceInstanceUuid:'source-1',dataDiskGB:10});
 await assert.rejects(second.manager.execute(p.id,{confirmed:true}),{code:'PLAN_EXPIRED'});first.state.snapshot.image.cuda_version='12.2';await assert.rejects(first.manager.execute(p.id,{confirmed:true}),{code:'PLAN_CHANGED'});assert.equal(first.state.writes.length,0);
});
test('plans expire after two minutes and stock loss prevents confirmed paid requests',async()=>{
 const {manager,state}=fixture();const plan=await manager.prepare('create',creation);const realNow=Date.now;try{Date.now=()=>plan.expiresAt+1;await assert.rejects(manager.execute(plan.id,{confirmed:true}),{code:'PLAN_EXPIRED'});}finally{Date.now=realNow;}
 const next=await manager.prepare('create',creation);state.machine.gpu_idle_num=0;await assert.rejects(manager.execute(next.id,{confirmed:true}),{code:'NO_STOCK'});assert.equal(state.writes.length,0);
});
test('clone refuses undersized copied data disks and preserves private/source application references',async()=>{
 const {manager,state}=fixture();await assert.rejects(manager.prepare('clone',{machineId:123,gpuCount:1,sourceInstanceUuid:'source-1',copyDataDisk:true}),{code:'DATA_DISK_UNAVAILABLE'});
 const plan=await manager.prepare('clone',{machineId:123,gpuCount:1,sourceInstanceUuid:'source-1'});assert.equal(plan.body.instance_info.copy_data_disk_after_clone,false);assert.equal(plan.body.instance_info.private_image_uuid,'private-1');assert.equal(state.writes.length,0);
});
test('minimum-total clone copying expands only enough for the larger of the requested minimum and source disk',async()=>{
 const {manager,state}=fixture(),args={machineId:123,gpuCount:1,sourceInstanceUuid:'source-1',copyDataDisk:true,minDataDiskGB:50};
 const plan=await manager.prepare('clone',args);assert.equal(plan.configuration.dataDiskGB,10);assert.equal(plan.configuration.totalDataDiskGB,60);assert.equal(plan.quote.totalHourly,2.22);assert.equal(plan.body.price_info.expand_data_disk,10*GB);
 await manager.execute(plan.id,{confirmed:true});assert.equal(state.writes.length,1);assert.equal(state.writes[0].body.instance_info.expand_data_disk,10*GB);
 const larger=await manager.prepare('clone',{...args,minDataDiskGB:70});assert.equal(larger.configuration.dataDiskGB,20);assert.equal(larger.configuration.totalDataDiskGB,70);assert.equal(larger.body.price_info.expand_data_disk,20*GB);
 state.machine.max_data_disk_expand_size=5*GB;await assert.rejects(manager.prepare('clone',args),{code:'DATA_DISK_UNAVAILABLE'});
});
test('minimum-total clone copying rechecks source capacity before payment and preserves fixed disk semantics',async()=>{
 const {manager,state}=fixture(),args={machineId:123,gpuCount:1,sourceInstanceUuid:'source-1',copyDataDisk:true,minDataDiskGB:50};
 const plan=await manager.prepare('clone',args);state.snapshot.expand_data_disk_size=30*GB;
 await assert.rejects(manager.execute(plan.id,{confirmed:true}),{code:'PLAN_CHANGED'});assert.equal(state.writes.length,0);
 const next=await manager.prepare('clone',args);assert.equal(next.configuration.dataDiskGB,30);assert.equal(next.configuration.totalDataDiskGB,80);assert.equal(next.body.price_info.expand_data_disk,30*GB);
 await assert.rejects(manager.prepare('clone',{machineId:123,gpuCount:1,sourceInstanceUuid:'source-1',copyDataDisk:true,dataDiskGB:0}),{code:'DATA_DISK_UNAVAILABLE'});
});
test('minimum and grouped GPU rentals respect host rules instead of submitting forbidden counts',async()=>{
 const {manager,state}=fixture();state.machine.rent_mode='Base4';await assert.rejects(manager.prepare('create',creation),{code:'HOST_CONFIG_MISMATCH'});
 state.machine.rent_mode='Unit4';await assert.rejects(manager.prepare('create',creation),{code:'HOST_CONFIG_MISMATCH'});
 const plan=await manager.prepare('create',{...creation,gpuCount:4});assert.equal(plan.configuration.gpuCount,4);assert.equal(state.writes.length,0);
});

test('new GPU architectures reject images below the provider CUDA minimum before any payment',async()=>{
 const {manager,state}=fixture();state.gpuSeries='NVIDIA-Blackwell';state.machine.highest_cuda_version='13.0';
 await assert.rejects(manager.prepare('create',creation),{code:'IMAGE_INCOMPATIBLE'});assert.equal(state.writes.length,0);
});

test('the final in-memory authorization runs after asynchronous provisioning revalidation and before payment',async()=>{
 const {manager,state,api}=fixture(),plan=await manager.prepare('create',creation),request=api.request;let entered,release,allowed=true;
 const reading=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve);
 api.request=async(ep,body)=>{if(ep.path==='/api/v1/order/price/preview'){entered();await gate;}return request(ep,body);};
 const executing=manager.execute(plan.id,{confirmed:true,beforeSubmit:()=>{if(!allowed)throw Object.assign(new Error('stopped'),{code:'TASK_STOPPED'});}});await reading;allowed=false;release();
 await assert.rejects(executing,{code:'TASK_STOPPED'});assert.equal(state.writes.length,0);await assert.rejects(manager.execute(plan.id,{confirmed:true}),{code:'PLAN_EXPIRED'});
});

test('a provisioning plan that expires during price revalidation never reaches the paid endpoint',async()=>{
 const {manager,state,api}=fixture(),plan=await manager.prepare('create',creation),request=api.request,realNow=Date.now;
 api.request=async(ep,body)=>{const result=await request(ep,body);if(ep.path==='/api/v1/order/price/preview')Date.now=()=>plan.expiresAt;return result;};
 try{await assert.rejects(manager.execute(plan.id,{confirmed:true}),{code:'PLAN_EXPIRED'});}finally{Date.now=realNow;}
 assert.equal(state.writes.length,0);
});
