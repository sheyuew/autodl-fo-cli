import {randomUUID} from 'node:crypto';
const fail=(code,message)=>Object.assign(new Error(message),{code});
const pick=(row,keys)=>Object.fromEntries(keys.filter(k=>row?.[k]!==undefined).map(k=>[k,row[k]]));
const stopped=['shutdown','shutdown_by_starting_error','shutdown_by_running_error'];
const actions=Object.freeze({
 powerOn:{path:'power_on',label:'开机',states:stopped},
 powerOff:{path:'power_off',label:'关机',states:['running','starting']},
 restart:{path:'restart',label:'重启',states:['running']},
 rename:{path:'name',method:'PUT',label:'重命名'},
 timedShutdown:{path:'timed/shutdown',label:'定时关机',states:['running']},
 cancelShutdown:{path:'timed/shutdown',label:'取消定时关机'},
 saveImage:{path:'image/save',label:'保存系统盘镜像',states:stopped},
 release:{path:'release',label:'释放实例',states:stopped},
});
const instanceKeys=['uuid','name','status','sub_status','region_sign','region_name','snapshot_gpu_alias_name','req_gpu_amount','cpu_limit','mem_limit_in_byte','charge_type','start_mode','payg_price','daily_price','created_at','started_at','stopped_at','expired_at','timed_shutdown_at','expand_data_disk_size','expand_system_disk_size','root_fs_used_size','root_fs_total_size','cpu_usage_percent','mem_usage_percent','disk_health_status'];
const clean=value=>Array.isArray(value)?value.map(clean):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).filter(([k])=>!/password|token|secret|credential|authorization|access_key|private_key|download_url/i.test(k)).map(([k,v])=>[k,clean(v)])):value;
function name(value){if(typeof value!=='string'||!value.trim()||Array.from(value.trim()).length>32||/[\x00-\x1f\x7f]/.test(value))throw fail('INVALID_REQUEST','名称需为 1 至 32 个字符');return value.trim();}
function shutdownAt(value){
 if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(value))throw fail('INVALID_REQUEST','请输入北京时间 YYYY-MM-DD HH:mm');
 const time=Date.parse(value.replace(' ','T')+':00+08:00');
 if(!Number.isFinite(time)||new Date(time+8*3600000).toISOString().slice(0,16).replace('T',' ')!==value||time<Date.now()+60000||time>Date.now()+366*86400000)throw fail('INVALID_REQUEST','定时关机时间需在一分钟后、一年以内（北京时间）');
 return value;
}
export class InstanceManager{
 #api;#plans=new Map();#imagePlans=new Map();
 constructor(api){this.#api=api;}
 async #own(uuid){if(typeof uuid!=='string'||!uuid)throw fail('INSTANCE_REQUIRED','请先选择实例');const row=(await this.#api.instances()).find(r=>r.uuid===uuid);if(!row)throw fail('INSTANCE_REQUIRED','实例不属于当前账号或已释放');return row;}
 async info(uuid){const row=await this.#own(uuid),s=await this.#api.snapshot(uuid);return clean({...pick(row,instanceKeys),config:pick(s,['image','snapshot_gpu_alias_name','expand_data_disk_size','expand_system_disk_size','system_init_disk_size']),machine:pick(s.machine_info_snapshot,['cpu_num','cpu_name','memory','region_name','gpu_type','max_instance_disk_size'])});}
 async connection(uuid,{includeSecrets=false,confirmed=false}={}){
  if(includeSecrets&&confirmed!==true)throw fail('CONFIRMATION_REQUIRED','显示连接密码前请确认 yes/no');
  const row=await this.#own(uuid);return {...pick(row,['uuid','name','status','ssh_command','proxy_host','ssh_port']),...(includeSecrets?pick(row,['root_password']):{})};
 }
 async monitor(uuid){await this.#own(uuid);return clean(await this.#api.read('instanceMonitor',{instance_uuid:uuid}));}
 async images(){return (await this.#api.pages('privateImages',{order_uuid:'',date_from:'',date_to:''})).map(r=>clean(pick(r,['image_uuid','name','status','image_size','created_at','framework','python_v','cuda_v','chip_corp','cpu_arch','progress_content','share_image_type'])));}
 async #ownImage(uuid){const image=(await this.#api.pages('privateImages',{order_uuid:'',date_from:'',date_to:''})).find(r=>r.image_uuid===uuid);if(!image||image.id==null)throw fail('IMAGE_REQUIRED','镜像不属于当前账号的可用列表，请刷新');return image;}
 async prepareImage(action,uuid,args={}){
  if(!['rename','delete'].includes(action))throw fail('UNSUPPORTED_OPERATION','不支持此镜像操作');
  const image=await this.#ownImage(uuid);if(action==='delete'&&image.share_image_type===1)throw fail('INVALID_REQUEST','请先在网页取消镜像共享，再删除');
  const body={image_id:image.id};if(action==='rename')body.image_name=name(args.name);
  const id=randomUUID(),expiresAt=Date.now()+120000;
  for(const [key,p] of this.#imagePlans)if(p.expiresAt<Date.now())this.#imagePlans.delete(key);
  if(this.#imagePlans.size>=32)this.#imagePlans.delete(this.#imagePlans.keys().next().value);
  this.#imagePlans.set(id,{action,uuid,body,expiresAt,fingerprint:JSON.stringify(pick(image,['id','image_uuid','name','status','share_image_type']))});
  return {id,expiresAt,action,imageUuid:uuid,name:image.name,body,label:action==='rename'?'重命名镜像':'删除或移除镜像',warning:action==='delete'?'此镜像将从当前账号移除；自己保存的镜像会被删除。':''};
 }
 async executeImage(id,{confirmed=false}={}){
  if(confirmed!==true)throw fail('CONFIRMATION_REQUIRED','请先核对镜像操作并确认 yes/no');
  const plan=this.#imagePlans.get(id);this.#imagePlans.delete(id);
  if(!plan||plan.expiresAt<Date.now())throw fail('PLAN_EXPIRED','确认已过期或已提交，请重新选择镜像');
  const image=await this.#ownImage(plan.uuid);
  if(JSON.stringify(pick(image,['id','image_uuid','name','status','share_image_type']))!==plan.fingerprint)throw fail('PLAN_CHANGED','镜像已变化，请重新确认');
  try{await this.#api.request({path:'/api/v1/image/private/'+(plan.action==='rename'?'update':'delete'),method:plan.action==='rename'?'POST':'DELETE'},plan.body);}
  catch(error){if(['NETWORK','SCHEMA_CHANGED'].includes(error.code)||error.retryable&&error.code==='API_ERROR')throw fail('ACTION_UNCERTAIN','请求结果未知，请先刷新镜像列表，避免重复提交');throw error;}
  return {accepted:true,action:plan.action,imageUuid:plan.uuid};
 }
 async #build(action,uuid,args={}){
  if(!Object.hasOwn(actions,action))throw fail('UNSUPPORTED_OPERATION','不支持此实例操作');
  const spec=actions[action],row=await this.#own(uuid);
  if(spec.states&&!spec.states.includes(row.status))throw fail('STATE_CHANGED',`${spec.label}不适用于当前状态 ${row.status}，请刷新实例列表`);
  const body={instance_uuid:uuid};let quote;
  if(action==='rename')body.instance_name=name(args.name);
  if(action==='saveImage'){body.image_name=name(args.name);body.try_again=false;}
  if(action==='timedShutdown')body.shutdown_at=shutdownAt(args.shutdownAt);
  if(action==='cancelShutdown')body.shutdown_at=null;
  if(action==='powerOn'){
   if(row.charge_type!=='payg')throw fail('QUOTE_UNAVAILABLE','当前开机报价只支持按量计费实例，包卡实例请暂用网页开机');
   const snapshot=await this.#api.snapshot(uuid);
   const price=await this.#api.request({path:'/api/v1/order/price/preview',method:'POST'},{charge_type:'payg',coupon_id_list:[],duration:1,expand_data_disk:snapshot.expand_data_disk_size||0,expand_system_disk:snapshot.expand_system_disk_size||0,machine_id:row.machine_id,num:row.req_gpu_amount});
   const compute=price?.payg_price,disk=price?.data_disk_info?.data_disk_deal_daily_price;
   if(!Number.isFinite(compute)||compute<0||!Number.isFinite(disk)||disk<0||snapshot.expand_system_disk_size>0)throw fail('QUOTE_UNAVAILABLE','未取得完整的计算与存储报价，请暂用网页开机');
   quote={currency:'CNY',computeHourly:compute/1000,storageDaily:disk/1000,totalHourly:Math.round((compute/1000+disk/24000)*1e6)/1e6,storagePrepaid:!!price.prepay_expand_data_disk};
  }
  const warning=action==='release'?'释放会永久删除此实例的系统盘和数据盘。':action==='powerOff'?'关机将中断运行中的程序；按量计费 GPU 会释放，再次开机可能无卡。':action==='restart'?'重启将中断运行中的程序。':action==='saveImage'?'仅保存系统盘，数据盘文件不包含在镜像内。':'';
  return {action,instanceUuid:uuid,label:spec.label,name:row.name||uuid,status:row.status,body,quote,warning,fingerprint:JSON.stringify(pick(row,['uuid','name','status','machine_id','req_gpu_amount','charge_type','start_mode','expand_data_disk_size','expand_system_disk_size']))};
 }
 async prepare(action,uuid,args={}){
  const plan=await this.#build(action,uuid,args),id=randomUUID(),expiresAt=Date.now()+120000;
  for(const [key,p] of this.#plans)if(p.expiresAt<Date.now())this.#plans.delete(key);
  if(this.#plans.size>=32)this.#plans.delete(this.#plans.keys().next().value);
  this.#plans.set(id,{...plan,args:structuredClone(args),expiresAt});
  return {id,expiresAt,...pick(plan,['action','instanceUuid','label','name','status','body','quote','warning'])};
 }
 async execute(id,{confirmed=false}={}){
  if(confirmed!==true)throw fail('CONFIRMATION_REQUIRED','请先核对操作并确认 yes/no');
  const plan=this.#plans.get(id);this.#plans.delete(id);
  if(!plan||plan.expiresAt<Date.now())throw fail('PLAN_EXPIRED','确认已过期或已提交，请重新选择操作');
  const current=await this.#build(plan.action,plan.instanceUuid,plan.args);
  if(current.fingerprint!==plan.fingerprint||JSON.stringify(current.quote)!==JSON.stringify(plan.quote))throw fail('PLAN_CHANGED','实例或报价已变化，请重新核对后确认');
  const spec=actions[plan.action];
  try{await this.#api.request({path:'/api/v1/instance/'+spec.path,method:spec.method||'POST'},plan.body);}
  catch(error){if(['NETWORK','SCHEMA_CHANGED'].includes(error.code)||error.retryable&&error.code==='API_ERROR')throw fail('ACTION_UNCERTAIN','请求结果未知，请先刷新实例或镜像状态，避免重复提交');throw error;}
  return {accepted:true,action:plan.action,instanceUuid:plan.instanceUuid};
 }
}
