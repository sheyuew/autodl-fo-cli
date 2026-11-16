import {createServer} from 'node:http';
import {createConnection} from 'node:net';
import {once} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {startHttpServer} from '../http-server.mjs';
export const GB=1024**3;
export async function provisionFixture(t){
 const directory=await mkdtemp(join(tmpdir(),'fo-provision-rpc-')),seen=[],events=[];
 const state={idle:2,price:2200,created:false,sourceStatus:'shutdown'};
 const machine={machine_id:123,region_sign:'west-A',region_name:'West',gpu_name:'RTX 4090',gpu_memory:24*GB,gpu_number:8,on_line:2,max_instance_num:20,binding_instance_num:3,max_instance_disk_size:50*GB,max_data_disk_expand_size:500*GB,chip_corp:'nvidia',cpu_arch:'amd64',driver_version:'550.1',highest_cuda_version:'12.4',rent_mode:''};
 state.machines=[machine];
 const source={uuid:'source',machine_id:123,name:'source',status:'shutdown',charge_type:'payg',private_image_uuid:'private-1',expand_data_disk_size:10*GB,region_sign:'west-A',req_gpu_amount:1};
 const server=createServer(async(q,r)=>{
  let raw='';for await(const p of q)raw+=p;const body=raw?JSON.parse(raw):{};seen.push({path:q.url,method:q.method,body});let data;
  const path=new URL(q.url,'http://fixture').pathname;
  if(path==='/api/v1/sub_user/login')data={ticket:body.sub_name,user:{id:1,sub_name:body.sub_name}};
  else if(path==='/api/v1/sub_user/passport')data={token:'fixture-private-token-'+body.ticket};
  else if(path==='/api/v1/sub_user/instance'){if(state.instanceGate)await state.instanceGate;data={list:[{...source,status:state.sourceStatus},...(state.created?[{uuid:'created',name:'created',status:'running',machine_id:123,region_sign:'west-A',req_gpu_amount:1}]:[])],result_total:state.created?2:1};}
  else if(path==='/api/v1/sub_user/instance/snapshot')data={image:{image_type:'private',image_name:'Private',chip_corp:'nvidia',cpu_arch:'amd64',cuda_version:'12.1'},expand_system_disk_size:0,expand_data_disk_size:10*GB,machine_info_snapshot:machine};
  else if(path==='/api/v1/sub_user/user/machine/list'){const list=state.machines.filter(row=>body.machine_id===undefined||String(row.machine_id)===String(body.machine_id)).map(row=>({...row,...(body.machine_id===undefined?{}:state.machineDetails?.[String(body.machine_id)]),gpu_idle_num:row.gpu_idle_num??state.idle,secret_token:'must-not-leak'}));data={list,result_total:list.length};}
  else if(path==='/api/v1/sub_user/region/list')data=[{region_name:'West',region_sign:'west-A',visible:'all',used_for:'all'}];
  else if(path==='/api/v1/sub_user/machine/gpu_type')data=state.gpuTypes||[{gpu_name:'RTX 4090',gpu_series_type:'NVIDIA-Ada'}];
  else if(path==='/api/v1/sub_user/image/all')data=[{label_name:'PyTorch',children:[{label_name:'2.5',children:[{label_name:'3.12',children:[{label_name:{uuid:'base-1',v:'12.1',chip_corp:'nvidia',cpu_arch:'amd64'}}]}]}]}];
  else if(path==='/api/v1/sub_user/image/private/get')data=[{image_uuid:'private-1',name:'Private',cuda_v:'12.1',chip_corp:'nvidia',cpu_arch:'amd64'}];
  else if(path==='/api/v1/sub_user/order/price/preview')data={payg_price:state.price,data_disk_info:{data_disk_deal_daily_price:body.expand_data_disk/GB*48},prepay_expand_data_disk:false};
  else if(path==='/api/v1/sub_user/order/data_disk/change/preview')data={max_expand_size:500*GB,data_disk_deal_daily_price:960};
  else if(path==='/api/v1/sub_user/order/data_disk/change')data=null;
  else if(['/api/v1/sub_user/order/instance/create/payg','/api/v1/sub_user/order/instance/clone/payg'].includes(path)){
   if(state.provisionStatus){r.statusCode=state.provisionStatus;r.end('service unavailable');return;}
   if(state.provisionError){r.end(JSON.stringify({code:state.provisionError,msg:'private-provider-detail token=must-not-save'}));return;}
   state.created=true;data='created';
  }
  else if(path==='/api/v1/sub_user/instance/power_on'){state.sourceStatus='running';data=null;}
  else {r.statusCode=404;r.end(JSON.stringify({code:'FixtureUnexpectedEndpoint'}));return;}
  r.end(JSON.stringify({code:'Success',data}));
 });
 server.listen(0,'127.0.0.1');await once(server,'listening');const baseUrl=`http://127.0.0.1:${server.address().port}`,services=[];
 const start=async(name)=>{
  const profile=join(directory,name),socket=join(directory,name+'.sock');const service=await startHttpServer({state:profile,socket,baseUrl,logger:()=>{},notify:event=>events.push(event)});services.push(service);
  const request=q=>new Promise((resolve,reject)=>{const c=createConnection(socket);let raw='';c.on('connect',()=>c.end(JSON.stringify(q)+'\n'));c.on('data',p=>raw+=p);c.on('error',reject);c.on('end',()=>{try{const reply=JSON.parse(raw);if(!reply.ok)reject(Object.assign(new Error(reply.error),{code:reply.code}));else resolve(reply.result);}catch(error){reject(error);}});});
  return{request,profile,service};
 };
 t.after(async()=>{for(const service of services)await service.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(directory,{recursive:true,force:true});});
 const login=(request,username='alice@team')=>request({op:'login-password',username,password:'fixture-password'});
 return{directory,start,seen,events,state,baseUrl,login};
}
export const creation={machineId:123,gpuCount:1,imageUuid:'base-1',name:'created',dataDiskGB:10};
export const policy={mode:'create',regionSigns:['west-A'],gpuNames:['RTX 4090'],gpuCount:1,imageUuid:'base-1',name:'created',dataDiskGB:10,maxHourly:3,maxMinutes:1,maxAttempts:3,intervalSeconds:10};
export async function until(fn,{timeout=15000}={}){const started=Date.now();for(;;){const result=await fn();if(result)return result;if(Date.now()-started>timeout)throw new Error('Timed out waiting for task');await new Promise(resolve=>setTimeout(resolve,50));}}
