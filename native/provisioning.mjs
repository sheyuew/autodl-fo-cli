import {randomUUID} from 'node:crypto';
import {quoteOrderPrice} from './price-quote.mjs';
const GB=1024**3;
const fail=(code,message)=>Object.assign(new Error(message),{code});
const pick=(row,keys)=>Object.fromEntries(keys.filter(k=>row?.[k]!==undefined).map(k=>[k,structuredClone(row[k])]));
const machineKeys=['machine_id','region_sign','region_name','gpu_name','gpu_memory','gpu_number','gpu_idle_num','on_line','max_instance_num','binding_instance_num','max_instance_disk_size','max_data_disk_expand_size','chip_corp','cpu_arch','driver_version','highest_cuda_version','rent_mode','disk_type','machine_sku_info','rent_deadline'];
const stopped=['shutdown','shutdown_by_starting_error','shutdown_by_running_error'];
const filters={charge_type:'payg',gpu_type_name:[],gpu_idle_num:0,region_sign_list:[],default_order:true,machine_tag_name:[],mount_net_disk:false,cpu_arch:[],chip_corp:[],instance_disk_size_order:'',date_range:'',date_from:'',date_to:'',pay_price_order:'',gpu_idle_type:''};
function identifier(value,label){if(!['string','number'].includes(typeof value)||!String(value).trim()||String(value).length>160||/[\x00-\x1f\x7f]/.test(String(value)))throw fail('INVALID_REQUEST',`请指定${label}`);return value;}
function integer(value,label,{min=0,max=100000}={}){if(!Number.isSafeInteger(value)||value<min||value>max)throw fail('INVALID_REQUEST',`${label}需为 ${min} 至 ${max} 的整数`);return value;}
function instanceName(value=''){if(typeof value!=='string'||Array.from(value.trim()).length>32||/[\x00-\x1f\x7f]/.test(value))throw fail('INVALID_REQUEST','实例名称最多 32 个字符');return value.trim();}
function version(value){return String(value||'').split('.').map(x=>Number.parseInt(x,10)||0);}
function greater(a,b){const x=version(a),y=version(b);for(let i=0;i<Math.max(x.length,y.length);i++)if((x[i]||0)!==(y[i]||0))return(x[i]||0)>(y[i]||0);return false;}
function compatible(image,machine){
 if(image.chipCorp&&machine.chip_corp!=='cpu'&&image.chipCorp!==machine.chip_corp||image.cpuArch&&image.cpuArch!==machine.cpu_arch)throw fail('IMAGE_INCOMPATIBLE','镜像芯片或 CPU 架构与所选主机不匹配');
 if(machine.chip_corp==='nvidia'&&image.cudaVersion&&machine.highest_cuda_version&&greater(image.cudaVersion,machine.highest_cuda_version))throw fail('IMAGE_INCOMPATIBLE','镜像 CUDA 高于所选主机支持的最高版本');
 if(machine.chip_corp==='mthreads'){const musa={'2.7.0':'3.1.0','5.2.0-server':'5.2.0'}[machine.driver_version];if(musa&&String(image.cudaVersion)!==musa)throw fail('IMAGE_INCOMPATIBLE','镜像 MUSA 与所选主机驱动版本不匹配');}
}
function imageFilters(machine){if(typeof machine.chip_corp!=='string'||!machine.chip_corp||typeof machine.cpu_arch!=='string'||!machine.cpu_arch)throw fail('SCHEMA_CHANGED','主机缺少镜像兼容性所需的架构字段');return{cpu_arch:[machine.cpu_arch],chip_corp:machine.chip_corp==='cpu'?[]:[machine.chip_corp]};}
function flattenBase(tree){
 if(!Array.isArray(tree))throw fail('SCHEMA_CHANGED','基础镜像目录结构发生变化');const rows=[];
 function walk(nodes,path=[]){for(const node of nodes){if(!node||typeof node!=='object')throw fail('SCHEMA_CHANGED','基础镜像节点结构发生变化');if(Array.isArray(node.children)){walk(node.children,[...path,String(node.label_name||'')]);continue;}const image=node.label_name;if(!image||typeof image!=='object'||typeof image.uuid!=='string')throw fail('SCHEMA_CHANGED','基础镜像缺少可选 UUID');rows.push({imageUuid:image.uuid,imageType:'base',name:path.join(' / '),path,cudaVersion:image.v||'',chipCorp:image.chip_corp||'',cpuArch:image.cpu_arch||'',isDesktop:!!image.is_desktop});}}
 walk(tree);return rows;
}
function available(machine,count){
 if([3,4,5,6].includes(machine.on_line)||!Number.isFinite(machine.gpu_idle_num)||machine.gpu_idle_num<count||Number.isFinite(machine.max_instance_num)&&Number.isFinite(machine.binding_instance_num)&&machine.max_instance_num<=machine.binding_instance_num)throw fail('NO_STOCK','所选主机维护中、空闲 GPU 不足或实例数已满');
 if(Number.isFinite(machine.gpu_number)&&count>machine.gpu_number)throw fail('HOST_CONFIG_MISMATCH','GPU 数量超过主机总卡数');
 if(machine.rent_mode){const match=/^(Base|Unit)(\d+)$/.exec(machine.rent_mode);if(!match)throw fail('UNSUPPORTED_OPERATION','主机租用卡数规则发生变化，请重新选择');const n=Number(match[2]);if(!n)throw fail('SCHEMA_CHANGED','主机租用卡数规则不可用');if(machine.gpu_idle_num>=n&&(match[1]==='Base'?count<n:count%n!==0))throw fail('HOST_CONFIG_MISMATCH','GPU 数量不符合主机起租或成组租用限制');}
}
/** Account-scoped ordinary-container pay-as-you-go creation and clone plans. */
export class ProvisioningManager{
 #api;#plans=new Map();
 constructor(api){this.#api=api;}
 async #machine(id){identifier(id,'主机 ID');const rows=await this.#api.pages('machines',{...structuredClone(filters),machine_id:id});if(!Array.isArray(rows))throw fail('SCHEMA_CHANGED','主机目录结构发生变化');const row=rows.find(r=>String(r.machine_id)===String(id));if(!row)throw fail('NO_STOCK','所选主机不在当前账号可租用列表中');return row;}
 async #images(machine){const body=imageFilters(machine);const [base,privateRows]=await Promise.all([this.#api.request({path:'/api/v1/image/all',method:'POST'},body),this.#api.request({path:'/api/v1/image/private/get',method:'POST'},body)]);if(!Array.isArray(privateRows))throw fail('SCHEMA_CHANGED','私有镜像目录结构发生变化');return [...flattenBase(base),...privateRows.map(image=>{if(typeof image?.image_uuid!=='string')throw fail('SCHEMA_CHANGED','私有镜像缺少 UUID');return{imageUuid:image.image_uuid,imageType:'private',name:image.name||image.image_uuid,cudaVersion:image.cuda_v||'',chipCorp:image.chip_corp||'',cpuArch:image.cpu_arch||''};})];}
 async catalog({regionSigns,gpuNames=[],gpuCount=1,machineId}={}){
  integer(gpuCount,'GPU 数量',{min:1,max:1024});let rows;
  if(machineId!==undefined)rows=[await this.#machine(machineId)];else rows=await this.#api.machines({regionSigns,gpuNames,idle:gpuCount});
  if(!Array.isArray(rows))throw fail('SCHEMA_CHANGED','主机目录结构发生变化');
  return{machines:rows.map(r=>pick(r,machineKeys)),images:machineId!==undefined?await this.#images(rows[0]):[],drivers:rows.map(r=>({machineId:r.machine_id,driverVersion:r.driver_version||'',highestCudaVersion:r.highest_cuda_version||''})),...(machineId!==undefined?{imageMachineId:rows[0].machine_id}:{}),dataDiskGBMeaning:'additional-paid-capacity',systemDiskExpansionSupported:false};
 }
 async #build(mode,args={}){
  if(!['create','clone'].includes(mode))throw fail('UNSUPPORTED_OPERATION','只支持新建或克隆普通容器实例');
  if(args.chargeType!==undefined&&args.chargeType!=='payg')throw fail('UNSUPPORTED_OPERATION','当前新建和克隆只支持按量计费');
  if(args.systemDiskGB!==undefined&&args.systemDiskGB!==0)throw fail('UNSUPPORTED_OPERATION','普通容器不支持系统盘扩容；Pro 使用独立接口，当前不混用');
  if(args.dataDiskGB!==undefined&&args.minDataDiskGB!==undefined)throw fail('INVALID_REQUEST','固定额外付费数据盘与最低总容量只能选择一种');
  const gpuCount=integer(args.gpuCount,'GPU 数量',{min:1,max:1024}),minimumGpuMemory=args.minGpuMemoryGB===undefined?undefined:integer(args.minGpuMemoryGB,'每张 GPU 最低显存 GB',{min:1,max:10000}),minimum=args.minDataDiskGB===undefined?undefined:integer(args.minDataDiskGB,'最低数据盘总容量 GB',{min:1,max:1000000}),fixedDisk=minimum===undefined?integer(args.dataDiskGB??0,'额外付费数据盘 GB',{max:1000000}):undefined,name=instanceName(args.name),machine=await this.#machine(args.machineId);available(machine,gpuCount);
  const gpuMemoryGB=Number.isSafeInteger(machine.gpu_memory)&&machine.gpu_memory>0?machine.gpu_memory/GB:undefined;
  if(minimumGpuMemory!==undefined&&(gpuMemoryGB===undefined||gpuMemoryGB<minimumGpuMemory))throw fail('HOST_CONFIG_MISMATCH','所选主机每张 GPU 显存不足或无法核实显存容量');
  if(!Number.isSafeInteger(machine.max_instance_disk_size)||machine.max_instance_disk_size<0||!Number.isSafeInteger(machine.max_data_disk_expand_size)||machine.max_data_disk_expand_size<0)throw fail('SCHEMA_CHANGED','主机缺少可验证的免费数据盘容量或扩容上限');
  let dataDiskGB=minimum===undefined?fixedDisk:Math.max(0,Math.ceil(minimum-machine.max_instance_disk_size/GB)),expand=dataDiskGB*GB;
  if(expand>machine.max_data_disk_expand_size)throw fail('DATA_DISK_UNAVAILABLE','额外数据盘容量超过所选主机的扩容上限');
  if(args.driverVersion!==undefined&&args.driverVersion!==machine.driver_version)throw fail('HOST_CONFIG_MISMATCH','驱动由所选主机决定，不能在创建请求中更换主机驱动');
  const instance={machine_id:machine.machine_id,charge_type:'payg',req_gpu_amount:gpuCount,base_image_uuid:'',private_image_uuid:'',reproduction_uuid:'',cg_application_uuid:'',cg_application_info:{image_name:'',current_version_id:0,current_version:'',image_id:0},instance_name:name,expand_data_disk:expand};
  const body={instance_info:instance,price_info:{coupon_id_list:[],machine_id:machine.machine_id,charge_type:'payg',duration:1,num:gpuCount,expand_data_disk:expand}};let image,sourceFingerprint,source;
  if(mode==='create'){
   if(!['base','private'].includes(args.imageType??'base'))throw fail('UNSUPPORTED_OPERATION','当前新建支持基础镜像和当前账号可用的私有镜像');
   const images=await this.#images(machine);image=images.find(r=>r.imageUuid===args.imageUuid&&r.imageType===(args.imageType??'base'));
   if(!image)throw fail('IMAGE_REQUIRED','镜像不在所选主机当前可用目录中，请重新选择');
   instance[image.imageType==='base'?'base_image_uuid':'private_image_uuid']=image.imageUuid;instance.reproduction_id=0;
  }else{
   identifier(args.sourceInstanceUuid,'源实例 UUID');const row=(await this.#api.instances()).find(r=>r.uuid===args.sourceInstanceUuid);
   if(!row)throw fail('INSTANCE_REQUIRED','源实例不属于当前账号或已释放');if(!stopped.includes(row.status))throw fail('STATE_CHANGED','克隆前需要先关闭源实例');if(row.charge_type!=='payg')throw fail('UNSUPPORTED_OPERATION','当前仅验证了按量计费普通容器的克隆');
   const snapshot=await this.#api.snapshot(row.uuid);if(snapshot.expand_system_disk_size>0)throw fail('UNSUPPORTED_OPERATION','当前克隆仅支持普通容器，不混用 Pro 或扩容系统盘接口');
   const info=snapshot.image;if(!info||typeof info!=='object')throw fail('SCHEMA_CHANGED','源实例镜像结构发生变化');
   image={imageUuid:info.image_name||'',imageType:info.image_type,name:info.image_name||'',cudaVersion:info.cuda_version||'',chipCorp:info.chip_corp||'',cpuArch:info.cpu_arch||''};
   if(info.image_type==='public')instance.base_image_uuid=info.image_name||'';instance.private_image_uuid=row.private_image_uuid||'';instance.reproduction_uuid=row.reproduction_uuid||'';instance.reproduction_id=row.reproduction_id||0;instance.cg_application_uuid=snapshot.cg_application_uuid||'';instance.cg_application_info=pick(snapshot.cg_application_info||{},['image_name','app_name','current_version_id','current_version','image_id']);
   if(!instance.base_image_uuid&&!instance.private_image_uuid&&!instance.reproduction_uuid&&!instance.cg_application_uuid)throw fail('IMAGE_REQUIRED','源实例没有可验证的镜像引用，暂不能克隆');
   if(args.copyDataDisk!==undefined&&typeof args.copyDataDisk!=='boolean')throw fail('INVALID_REQUEST','是否拷贝数据盘必须为 true 或 false');
   instance.copy_data_disk_after_clone=args.copyDataDisk===true;instance.keep_src_user_service_address_after_clone=false;instance.ft_sparse=false;body.instance_uuid=row.uuid;
   if(instance.copy_data_disk_after_clone){
    const sourceFree=snapshot.machine_info_snapshot?.max_instance_disk_size,sourceExpand=snapshot.expand_data_disk_size??row.expand_data_disk_size??0;
    if(!Number.isSafeInteger(sourceFree)||!Number.isSafeInteger(sourceExpand))throw fail('SCHEMA_CHANGED','无法验证源实例的数据盘容量');
    if(minimum!==undefined){
     dataDiskGB=Math.max(0,Math.ceil((Math.max(minimum*GB,sourceFree+sourceExpand)-machine.max_instance_disk_size)/GB));expand=dataDiskGB*GB;
     if(expand>machine.max_data_disk_expand_size)throw fail('DATA_DISK_UNAVAILABLE','额外数据盘容量超过所选主机的扩容上限');
     instance.expand_data_disk=expand;body.price_info.expand_data_disk=expand;
    }
    if(machine.max_instance_disk_size+expand<sourceFree+sourceExpand)throw fail('DATA_DISK_UNAVAILABLE','拷贝数据盘时目标总容量不得小于源数据盘总容量');
   }
   source={uuid:row.uuid,name:row.name,status:row.status,copyDataDisk:instance.copy_data_disk_after_clone};sourceFingerprint=JSON.stringify({row:pick(row,['uuid','status','charge_type','private_image_uuid','reproduction_uuid','reproduction_id','expand_data_disk_size']),image:info,cg_application_uuid:snapshot.cg_application_uuid,cg_application_info:instance.cg_application_info,expand_data_disk_size:snapshot.expand_data_disk_size,expand_system_disk_size:snapshot.expand_system_disk_size,freeDataDisk:snapshot.machine_info_snapshot?.max_instance_disk_size});
  }
  compatible(image,machine);
  if(machine.chip_corp==='nvidia'){
   const gpuTypes=await this.#api.read('gpuTypes');if(!Array.isArray(gpuTypes))throw fail('SCHEMA_CHANGED','GPU 架构目录结构发生变化');
   const gpu=gpuTypes.find(g=>g.gpu_name===machine.gpu_name);if(!gpu||typeof gpu.gpu_series_type!=='string')throw fail('SCHEMA_CHANGED','无法从 GPU 目录核对所选型号的架构');
   const minimum={'NVIDIA-Ampere':'11.0','NVIDIA-Ada':'11.3','NVIDIA-Blackwell':'12.8'}[gpu.gpu_series_type];
   if(minimum&&(!image.cudaVersion||greater(minimum,image.cudaVersion)))throw fail('IMAGE_INCOMPATIBLE',`所选 GPU 架构至少需要 CUDA ${minimum}，请重新选择镜像`);
   image={...image,gpuSeries:gpu.gpu_series_type};
  }
  const price=await this.#api.request({path:'/api/v1/order/price/preview',method:'POST'},body.price_info),quote=quoteOrderPrice(price,{expandDataDiskBytes:expand,expandSystemDiskBytes:0});
  const configuration={machineId:machine.machine_id,regionSign:machine.region_sign,gpuName:machine.gpu_name,gpuCount,...(gpuMemoryGB===undefined?{}:{gpuMemoryGB}),chargeType:'payg',name:instance.instance_name,freeDataDiskGB:machine.max_instance_disk_size/GB,dataDiskGB,totalDataDiskGB:machine.max_instance_disk_size/GB+dataDiskGB,systemDiskGB:30,driverVersion:machine.driver_version,highestCudaVersion:machine.highest_cuda_version,image};
  return{mode,configuration,source,body,quote,warning:'提交后将创建新的按量计费实例并开始计费；扩容数据盘关机后仍按平台规则收费。'+(mode==='clone'?'源实例会保留；系统盘必选拷贝，数据盘仅在明确选择时拷贝。':''),fingerprint:JSON.stringify({machine:pick(machine,machineKeys.filter(k=>!['gpu_idle_num','binding_instance_num','machine_sku_info'].includes(k))),body,quote,image,sourceFingerprint})};
 }
 async prepare(mode,args={}){
  const plan=await this.#build(mode,args),id=randomUUID(),expiresAt=Date.now()+120000;for(const[k,p]of this.#plans)if(p.expiresAt<Date.now())this.#plans.delete(k);if(this.#plans.size>=64)this.#plans.delete(this.#plans.keys().next().value);this.#plans.set(id,{...plan,args:structuredClone(args),expiresAt});
  return{id,expiresAt,...pick(plan,['mode','configuration','source','body','quote','warning'])};
 }
 async execute(id,{confirmed=false,beforeSubmit}={}){
  if(confirmed!==true)throw fail('CONFIRMATION_REQUIRED','请核对主机、GPU 数量、镜像、数据盘和完整费用，确认 yes/no');
  const plan=this.#plans.get(id);this.#plans.delete(id);if(!plan||plan.expiresAt<=Date.now())throw fail('PLAN_EXPIRED','新建或克隆确认已过期、属于其他账号或已提交');
  const current=await this.#build(plan.mode,plan.args);if(current.fingerprint!==plan.fingerprint)throw fail('PLAN_CHANGED','主机配置、镜像、源实例或完整报价已变化，请重新确认');
  if(plan.expiresAt<=Date.now())throw fail('PLAN_EXPIRED','新建或克隆确认在复查期间已过期，请重新预览');
  if(typeof beforeSubmit==='function')beforeSubmit();
  let result;try{result=await this.#api.request({path:`/api/v1/order/instance/${plan.mode}/payg`,method:'POST'},plan.body);}catch(error){if(['NETWORK','SCHEMA_CHANGED'].includes(error.code)||error.code==='API_ERROR'&&error.retryable)throw Object.assign(fail('ACTION_UNCERTAIN','创建请求结果未知；请先查询实例列表，不要重复提交'),pick(error,['providerCode','operation','httpStatus']),{retryable:false});throw error;}
  const uuid=typeof result==='string'?result:result?.instance_uuid||result?.uuid;
  if(typeof uuid!=='string'||!uuid.trim())throw fail('ACTION_UNCERTAIN','AutoDL 已响应但缺少新实例 UUID，请先查询实例列表，不要重复提交');
  return{accepted:true,state:'submitted',mode:plan.mode,instanceUuid:uuid,configuration:plan.configuration,quote:plan.quote};
 }
}
