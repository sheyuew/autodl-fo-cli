import {randomUUID} from 'node:crypto';
import {mkdir,readFile,writeFile,rename,unlink,chmod} from 'node:fs/promises';
import {join} from 'node:path';

const fail=(code,message)=>Object.assign(new Error(message),{code});
const activeStates=new Set(['waiting','quoting','submitting','verifying']);
const terminalStates=new Set(['submitted','completed','paused','uncertain','cancelled','expired','failed']);
const policyKeys=new Set(['mode','name','instanceUuid','sourceInstanceUuid','regionSigns','gpuNames','gpuCount','minGpuMemoryGB','imageUuid','imageType','driverVersion','dataDiskGB','minDataDiskGB','systemDiskGB','copyDataDisk','maxHourly','intervalSeconds','maxMinutes','maxAttempts']);
const permanentCodes=new Set(['PERMISSION_DENIED','QUOTA_EXCEEDED','INSTANCE_LIMIT','INSTANCE_LIMIT_EXCEEDED','LOGIN_REQUIRED','LOGIN_REJECTED','ACCOUNT_MISMATCH','UNSUPPORTED_OPERATION','INVALID_REQUEST','STATE_CHANGED','SCHEMA_CHANGED','IMAGE_REQUIRED','IMAGE_INCOMPATIBLE','DISK_LIMIT','DISK_SIZE_REQUIRED']);
const knownCodes=new Set([...permanentCodes,'NETWORK','ACTION_UNCERTAIN','NO_STOCK','STOCK_UNAVAILABLE','RATE_LIMITED','API_ERROR','QUOTE_UNAVAILABLE','PLAN_EXPIRED','PLAN_CHANGED','DATA_DISK_UNAVAILABLE','HOST_CONFIG_MISMATCH']);
const copy=value=>JSON.parse(JSON.stringify(value));
const text=value=>typeof value==='string'&&value.trim().length>0&&value.length<=200&&!/[\x00-\x1f]/.test(value);
const integer=(value,min,max=Number.MAX_SAFE_INTEGER)=>Number.isSafeInteger(value)&&value>=min&&value<=max;
const positive=(value,max=Number.MAX_VALUE)=>typeof value==='number'&&Number.isFinite(value)&&value>0&&value<=max;
function normalizePolicy(value){
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!policyKeys.has(k)))throw fail('INVALID_REQUEST','抢卡策略包含不支持的字段');
 const p=copy(value);
 if(!['powerOn','create','clone'].includes(p.mode)||!positive(p.maxHourly))throw fail('INVALID_REQUEST','请选择模式并明确每小时费用上限');
 p.intervalSeconds??=30;p.maxMinutes??=60;p.maxAttempts??=120;p.systemDiskGB??=0;p.imageType??='base';
 if(!['base','private'].includes(p.imageType))throw fail('INVALID_REQUEST','镜像类型应为base或private');
 if(!positive(p.intervalSeconds)||p.intervalSeconds<10||!positive(p.maxMinutes,1440)||!integer(p.maxAttempts,1,10000))throw fail('INVALID_REQUEST','轮询间隔至少10秒，时长最多1440分钟，次数最多10000次');
 if(p.systemDiskGB!==0)throw fail('UNSUPPORTED_OPERATION','此版本不执行系统盘扩容，请使用0');
 if(p.minGpuMemoryGB!==undefined&&!integer(p.minGpuMemoryGB,1,10000))throw fail('INVALID_REQUEST','每张 GPU 最低显存需为 1 至 10000 GB 的整数；不限制时省略此条件');
 for(const k of ['name','instanceUuid','sourceInstanceUuid','imageUuid','driverVersion'])if(p[k]!==undefined&&!text(p[k]))throw fail('INVALID_REQUEST','策略名称或实例参数无效');
 if(p.name!==undefined&&(Array.from(p.name.trim()).length>32||/\x7f/.test(p.name)))throw fail('INVALID_REQUEST','实例名称最多 32 个字符，不能包含控制字符');
 for(const k of ['regionSigns','gpuNames'])if(p[k]!==undefined&&(!Array.isArray(p[k])||p[k].length>100||p[k].some(v=>!text(v))))throw fail('INVALID_REQUEST','请选择有效的地区和显卡');
 for(const k of ['regionSigns','gpuNames'])if(p[k]!==undefined)p[k]=[...new Set(p[k])];
 if(p.mode==='powerOn'){
  if(!text(p.instanceUuid))throw fail('INVALID_REQUEST','开机模式需要指定实例');
  if(p.minDataDiskGB!==undefined)throw fail('UNSUPPORTED_OPERATION','已有实例开机使用原主机和原数据盘；跨主机匹配数据盘容量请使用克隆模式');
  if(p.minGpuMemoryGB!==undefined)throw fail('UNSUPPORTED_OPERATION','已有实例开机使用原 GPU；按最低显存跨主机筛选请使用新建或克隆模式');
 }else{
  const fixedDisk=p.dataDiskGB!==undefined,minimumDisk=p.minDataDiskGB!==undefined;
  if(!p.regionSigns?.length||!p.gpuNames?.length||!integer(p.gpuCount,1,64)||fixedDisk===minimumDisk||fixedDisk&&!integer(p.dataDiskGB,0,1000000)||minimumDisk&&!integer(p.minDataDiskGB,1,1000000))throw fail('INVALID_REQUEST','新建或克隆需明确地区、显卡、卡数；数据盘需二选一：固定额外付费 GB 或最低总容量 GB');
  if(p.mode==='create'&&!text(p.imageUuid)||p.mode==='clone'&&!text(p.sourceInstanceUuid))throw fail('INVALID_REQUEST','请选择镜像或克隆源实例');
  if(p.copyDataDisk!==undefined&&typeof p.copyDataDisk!=='boolean')throw fail('INVALID_REQUEST','复制数据盘选项应为布尔值');
  if(p.mode==='clone')p.copyDataDisk??=false;
 }
 return p;
}
function candidateSummary(candidate){
 if(candidate===null||candidate===undefined)return null;
 const result={};
 for(const key of ['instanceUuid','sourceInstanceUuid','machineId','regionSign','gpuName','imageUuid','driverVersion'])if(text(candidate[key]))result[key]=candidate[key];
 if(integer(candidate.machineId,0))result.machineId=candidate.machineId;
 for(const key of ['gpuCount','dataDiskGB','systemDiskGB'])if(integer(candidate[key],0))result[key]=candidate[key];
 for(const key of ['freeDataDiskGB','totalDataDiskGB','gpuMemoryGB'])if(positive(candidate[key])||candidate[key]===0)result[key]=candidate[key];
 if(candidate.quote&&typeof candidate.quote==='object'){
  const quote={};if(typeof candidate.quote.currency==='string'&&/^[A-Z]{3}$/.test(candidate.quote.currency))quote.currency=candidate.quote.currency;
  for(const key of ['computeHourly','dataDiskDaily','systemDiskDaily','storageDaily','totalHourly'])if(positive(candidate.quote[key])||candidate.quote[key]===0)quote[key]=candidate.quote[key];
  for(const key of ['storageChargedWhileStopped','storagePrepaid'])if(typeof candidate.quote[key]==='boolean')quote[key]=candidate.quote[key];
  if(Object.keys(quote).length)result.quote=quote;
 }
 return result;
}
function fingerprint(policy){
 if(policy.mode==='powerOn')return 'powerOn:'+policy.instanceUuid;
 if(policy.mode==='clone')return 'clone:'+policy.sourceInstanceUuid;
 return JSON.stringify(Object.fromEntries(Object.entries(policy).sort(([a],[b])=>a.localeCompare(b))));
}
const codeOf=error=>knownCodes.has(error?.code)?error.code:'ENGINE_ERROR';
const isPermanent=error=>permanentCodes.has(error?.code)||error?.code==='API_ERROR'&&error.retryable!==true;
function safeErrorDetail(value){
 if(!value||!['candidate','execute','observe'].includes(value.stage)||!knownCodes.has(value.code)&&value.code!=='ENGINE_ERROR')return;
 const detail={code:value.code,stage:value.stage};
 if(typeof value.providerCode==='string'&&/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(value.providerCode))detail.providerCode=value.providerCode;
 if(typeof value.operation==='string'&&/^\/api\/v1\/[A-Za-z0-9_/-]{1,140}$/.test(value.operation))detail.operation=value.operation;
 if(Number.isInteger(value.httpStatus)&&value.httpStatus>=100&&value.httpStatus<=599)detail.httpStatus=value.httpStatus;
 if(typeof value.retryable==='boolean')detail.retryable=value.retryable;
 return detail;
}
const messages={submitted:'请求已被接受，等待实例状态确认',completed:'实例已确认运行',uncertain:'提交结果未知，请查询实例状态；任务不会自动重试',cancelled:'已停止本地监控；已提交的实例请求不受影响',paused:'本地任务已暂停，需要重新预览并确认',expired:'监控已达到时间或次数上限；请查询已提交请求的实际状态',failed:'任务已停止，请检查错误码并重新预览'};

/** Account-scoped stock monitoring. Provider operations are supplied by the authenticated runtime. */
export class ResourceTasks {
 #tasks=new Map();#plans=new Map();#timers=new Map();#pendingResults=new Map();#jobs=new Map();#tail=Promise.resolve();#saveTail=Promise.resolve();#initialized=false;#closing=false;#initPromise;
 constructor({state,prepareCandidate,executeCandidate,observeResult,notify,intervalMinMs=10000,now=Date.now,timers={setTimeout,clearTimeout}}={}){
  if(typeof state!=='string'||!state||typeof prepareCandidate!=='function'||typeof executeCandidate!=='function'||!Number.isFinite(intervalMinMs)||intervalMinMs<0)throw fail('INVALID_REQUEST','任务引擎配置无效');
  Object.assign(this,{state,prepareCandidate,executeCandidate,observeResult,notify,intervalMinMs,now,timers});
 }
 get active(){return [...this.#tasks.values()].some(t=>activeStates.has(t.state));}
 async init(){
  return this.#initPromise??=(async()=>{
   await mkdir(this.state,{recursive:true,mode:0o700});await chmod(this.state,0o700);let stored;
   try{stored=JSON.parse(await readFile(join(this.state,'resource-tasks.json'),'utf8'));}catch(e){if(e.code!=='ENOENT')throw fail('STATE_INVALID','无法读取本地任务记录，请检查文件');}
   if(stored!==undefined&&(!stored||stored.version!==1||!Array.isArray(stored.tasks)))throw fail('STATE_INVALID','本地任务记录格式无效');
   for(const row of (stored?.tasks||[]).slice(-100)){
    if(!text(row?.id)||!activeStates.has(row.state)&&!terminalStates.has(row.state))continue;
    let policy;try{policy=normalizePolicy(row.policy);}catch{continue;}
    const task={id:row.id,policy,state:row.state,createdAt:typeof row.createdAt==='string'?row.createdAt:this.#at(),startedAt:typeof row.startedAt==='string'?row.startedAt:this.#at(),updatedAt:this.#at(),deadlineAt:typeof row.deadlineAt==='string'?row.deadlineAt:this.#at(),attempts:integer(row.attempts,0)?row.attempts:0,checks:integer(row.checks,0)?row.checks:0,submitted:row.submitted===true,history:[]};
    if(text(row.instanceUuid))task.instanceUuid=row.instanceUuid;
    if(row.candidate)task.candidate=candidateSummary(row.candidate);
    if(row.state==='submitting'){task.state='uncertain';task.errorCode='ACTION_UNCERTAIN';}
    else if(activeStates.has(row.state)){task.state='paused';task.errorCode='SESSION_ENDED';}
    else if(text(row.errorCode)&&/^[A-Z_]+$/.test(row.errorCode))task.errorCode=row.errorCode;
    const detail=safeErrorDetail(row.errorDetail);if(detail?.code===task.errorCode)task.errorDetail=detail;
    task.history=(Array.isArray(row.history)?row.history:[]).filter(v=>v&&typeof v.at==='string'&&(activeStates.has(v.state)||terminalStates.has(v.state))).slice(-29).map(v=>({at:v.at,state:v.state,...(typeof v.code==='string'&&/^[A-Z_]+$/.test(v.code)?{code:v.code}:{})}));
    task.history.push({at:this.#at(),state:task.state,...(task.errorCode?{code:task.errorCode}:{})});this.#tasks.set(task.id,task);
   }
   this.#initialized=true;await this.#save();return this.list();
  })();
 }
 #ready(){if(!this.#initialized||this.#closing)throw fail('SESSION_ENDED','本地任务引擎尚未启动或正在关闭');}
 #at(){return new Date(this.now()).toISOString();}
 list(){return [...this.#tasks.values()].map(copy);}
 info(id){const task=this.#tasks.get(id);if(!task)throw fail('TASK_REQUIRED','本地任务不存在');return copy(task);}
 async prepare(value){
  this.#ready();const policy=normalizePolicy(value);let candidate;
  try{candidate=await this.prepareCandidate(copy(policy));}catch(e){if(['NO_STOCK','STOCK_UNAVAILABLE'].includes(e.code))candidate=null;else throw e;}
  this.#ready();const plan={planId:randomUUID(),expiresAt:new Date(this.now()+120000).toISOString(),policy,candidate:candidateSummary(candidate),oneSuccessOnly:true,budget:{maxHourly:policy.maxHourly,maxMinutes:policy.maxMinutes,maxAttempts:policy.maxAttempts}};
  for(const [id,p] of this.#plans)if(Date.parse(p.expiresAt)<=this.now())this.#plans.delete(id);
  if(this.#plans.size>=100)this.#plans.delete(this.#plans.keys().next().value);this.#plans.set(plan.planId,plan);return copy(plan);
 }
 async start(planId,{confirmed}={}){
  this.#ready();if(confirmed!==true)throw fail('CONFIRMATION_REQUIRED','请核对抢卡模式、预算、时限和参数后确认 yes/no');
  const plan=this.#plans.get(planId);if(!plan||Date.parse(plan.expiresAt)<=this.now()){this.#plans.delete(planId);throw fail('PLAN_EXPIRED','抢卡计划已过期或已使用，请重新预览');}
  if([...this.#tasks.values()].some(t=>activeStates.has(t.state)&&fingerprint(t.policy)===fingerprint(plan.policy)))throw fail('TASK_CONFLICT','同一目标已有活动任务，请先查询或停止');
  if([...this.#tasks.values()].filter(t=>activeStates.has(t.state)).length>=20)throw fail('TASK_CONFLICT','同时活动任务已达到20个，请先停止现有任务');
  this.#plans.delete(planId);const at=this.#at(),task={id:randomUUID(),policy:copy(plan.policy),state:'waiting',createdAt:at,startedAt:at,updatedAt:at,deadlineAt:new Date(this.now()+plan.policy.maxMinutes*60000).toISOString(),attempts:0,checks:0,submitted:false,history:[{at,state:'waiting'}]};
  this.#tasks.set(task.id,task);this.#prune();try{await this.#save();}catch(e){this.#tasks.delete(task.id);throw e;}
  this.#schedule(task,0);return copy(task);
 }
 #prune(){
  while(this.#tasks.size>100){const expired=[...this.#tasks.values()].find(t=>!activeStates.has(t.state));if(!expired)break;this.#tasks.delete(expired.id);}
 }
 #change(task,state,code){task.state=state;task.updatedAt=this.#at();if(code)task.errorCode=code;else delete task.errorCode;if(!code||task.errorDetail?.code!==code)delete task.errorDetail;task.history.push({at:task.updatedAt,state,...(code?{code}:{})});task.history=task.history.slice(-30);}
 #captureError(task,error,stage){task.errorDetail=safeErrorDetail({...error,code:codeOf(error),stage});}
 async #finish(task,state,code){
  this.#clear(task.id);this.#change(task,state,code);task.completedAt=this.#at();this.#pendingResults.delete(task.id);await this.#save();
  await this.#notify(task);
 }
 async #notify(task){try{await this.notify?.({taskId:task.id,state:task.state,mode:task.policy.mode,submitted:task.submitted,...(task.instanceUuid?{instanceUuid:task.instanceUuid}:{}),...(task.errorCode?{errorCode:task.errorCode}:{}),at:this.#at(),message:messages[task.state]||'任务状态已改变'});}catch{}}
 #clear(id){if(this.#timers.has(id)){this.timers.clearTimeout(this.#timers.get(id));this.#timers.delete(id);}}
 #schedule(task,delay){
  if(this.#closing||!activeStates.has(task.state))return;this.#clear(task.id);
  delay=Math.min(delay,Math.max(0,Date.parse(task.deadlineAt)-this.now()));
  const timer=this.timers.setTimeout(()=>{
   this.#timers.delete(task.id);const job=this.#tail.catch(()=>{}).then(()=>this.#tick(task));this.#tail=job;this.#jobs.set(task.id,job);job.finally(()=>{if(this.#jobs.get(task.id)===job)this.#jobs.delete(task.id);}).catch(()=>{});return job;
  },delay);timer?.unref?.();this.#timers.set(task.id,timer);
 }
 #delay(task,error){
  let ms=Math.max(this.intervalMinMs,task.policy.intervalSeconds*1000);
  if(error?.code==='RATE_LIMITED')ms=Math.max(ms,Math.min(3600000,positive(error.retryAfterSeconds)?error.retryAfterSeconds*1000:ms*2));
  return ms;
 }
 async #wait(task,code,error){
  if(this.#closing||task.cancelRequested)return;
  if(task.attempts>=task.policy.maxAttempts)return this.#finish(task,'expired','ATTEMPTS_EXHAUSTED');
  this.#change(task,'waiting',code);await this.#save();this.#schedule(task,this.#delay(task,error));
 }
 async #observe(task){
  task.checks++;this.#change(task,'verifying');await this.#save();
  try{
   const result=await this.observeResult(this.#pendingResults.get(task.id),copy(task.policy));
   if(text(result?.instanceUuid))task.instanceUuid=result.instanceUuid;
   if(task.cancelRequested||this.#closing)return;
   if(result?.status==='running')return this.#finish(task,'completed');
   if(result?.status==='failed')return this.#finish(task,'failed','INSTANCE_FAILED');
  }catch(error){const code=codeOf(error);this.#captureError(task,error,'observe');if(isPermanent(error))return this.#finish(task,'paused',code);task.errorCode=code;}
  if(task.cancelRequested||this.#closing)return;
  await this.#save();this.#schedule(task,this.#delay(task));
 }
 async #tick(task){
  if(this.#closing||task.cancelRequested||!activeStates.has(task.state))return;
  try{
   if(this.now()>=Date.parse(task.deadlineAt))return await this.#finish(task,'expired','TIME_EXPIRED');
   if(task.state==='verifying')return await this.#observe(task);
   if(task.attempts>=task.policy.maxAttempts)return await this.#finish(task,'expired','ATTEMPTS_EXHAUSTED');
   task.attempts++;this.#change(task,'quoting');await this.#save();let candidate;
   try{candidate=await this.prepareCandidate(copy(task.policy));}
   catch(error){const code=codeOf(error);this.#captureError(task,error,'candidate');if(isPermanent(error))return await this.#finish(task,'failed',code);return await this.#wait(task,code,error);}
   if(this.#closing||task.cancelRequested)return;
   if(candidate===null||candidate===undefined)return await this.#wait(task,'NO_STOCK');
   task.candidate=candidateSummary(candidate);
   if(!positive(candidate.quote?.totalHourly)&&candidate.quote?.totalHourly!==0)return await this.#finish(task,'failed','QUOTE_UNAVAILABLE');
   if(candidate.quote.totalHourly>task.policy.maxHourly)return await this.#wait(task,'PRICE_LIMIT');
   if(this.now()>=Date.parse(task.deadlineAt))return await this.#finish(task,'expired','TIME_EXPIRED');
   // This write MUST finish before any paid provider call. A crash after it is uncertain on restart.
   this.#change(task,'submitting');await this.#save();
   if(this.#closing||task.cancelRequested)return;
   if(this.now()>=Date.parse(task.deadlineAt))return await this.#finish(task,'expired','TIME_EXPIRED');
   let result;
   const authorize=()=>{if(this.#closing||task.cancelRequested)throw fail('TASK_STOPPED','任务已停止，不再提交付费请求');if(this.now()>=Date.parse(task.deadlineAt))throw fail('TIME_EXPIRED','任务监控时限已到，不再提交付费请求');};
   try{result=await this.executeCandidate(candidate,copy(task.policy),authorize);}
   catch(error){
    if(error.code==='TASK_STOPPED'&&(this.#closing||task.cancelRequested)){this.#change(task,'waiting');return;}
    if(error.code==='TIME_EXPIRED'&&this.now()>=Date.parse(task.deadlineAt))return await this.#finish(task,'expired','TIME_EXPIRED');
    const code=codeOf(error);this.#captureError(task,error,'execute');if(isPermanent(error))return await this.#finish(task,'failed',code);if(['NO_STOCK','STOCK_UNAVAILABLE','RATE_LIMITED','PLAN_CHANGED','PLAN_EXPIRED','DATA_DISK_UNAVAILABLE','HOST_CONFIG_MISMATCH'].includes(code))return await this.#wait(task,code,error);return await this.#finish(task,'uncertain',code==='ENGINE_ERROR'?'ACTION_UNCERTAIN':code);
   }
   if(result?.accepted!==true)return await this.#finish(task,'uncertain','ACTION_UNCERTAIN');
   task.submitted=true;if(text(result.instanceUuid))task.instanceUuid=result.instanceUuid;
   if(task.cancelRequested||this.#closing){this.#change(task,'submitted');await this.#save();return;}
   if(typeof this.observeResult!=='function')return await this.#finish(task,'submitted');
   this.#pendingResults.set(task.id,result);this.#change(task,'verifying');await this.#save();await this.#observe(task);
  }catch{
   // A local persistence failure must stop authorization, never trigger another purchase.
   this.#clear(task.id);this.#change(task,'paused','STATE_WRITE_FAILED');await this.#notify(task);
  }
 }
 async cancel(id,{confirmed}={}){
  this.#ready();if(confirmed!==true)throw fail('CONFIRMATION_REQUIRED','请确认停止本地抢卡任务 yes/no');const task=this.#tasks.get(id);if(!task)throw fail('TASK_REQUIRED','本地任务不存在');
  if(!activeStates.has(task.state))return copy(task);
  task.cancelRequested=true;this.#clear(id);const job=this.#jobs.get(id);if(job)await job.catch(()=>{});
  delete task.cancelRequested;
  if(task.state==='uncertain'||task.state==='failed')return copy(task);
  await this.#finish(task,'cancelled');return copy(task);
 }
 async close(){
  if(this.#closing)return this.#tail.catch(()=>{});this.#closing=true;for(const id of this.#timers.keys())this.#clear(id);await this.#tail.catch(()=>{});
  for(const task of this.#tasks.values())if(activeStates.has(task.state)){this.#change(task,task.state==='submitting'?'uncertain':'paused',task.state==='submitting'?'ACTION_UNCERTAIN':'SESSION_ENDED');delete task.cancelRequested;}
  this.#plans.clear();this.#pendingResults.clear();if(this.#initialized)await this.#save();
 }
 async #save(){
  const data=JSON.stringify({version:1,tasks:[...this.#tasks.values()].map(task=>{const safe=copy(task);delete safe.cancelRequested;return safe;})})+'\n';
  const write=this.#saveTail.catch(()=>{}).then(async()=>{const target=join(this.state,'resource-tasks.json'),temp=target+'.'+randomUUID()+'.tmp';try{await writeFile(temp,data,{mode:0o600});await rename(temp,target);}catch(error){await unlink(temp).catch(()=>{});throw error;}});this.#saveTail=write;return write;
 }
}
