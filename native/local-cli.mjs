import {parseArgs} from 'node:util';
import {connectLocal,loginLocal,listLocalAccounts,selectLocalAccount,logoutLocal} from './local-session.mjs';
import {ask,secret,run as menu,followTransfers} from './cli.mjs';
import {isMain} from './is-main.mjs';
import {setTimeout as sleep} from 'node:timers/promises';

const fail=(code,message)=>Object.assign(new Error(message),{code});
const flags={json:{type:'boolean'},help:{type:'boolean',short:'h'},directory:{type:'boolean'},...Object.fromEntries(['account','confirm','regions','gpu','gpu-count','machine-id','size-gb','after','query','idle','name','shutdown-at','data','path','disk-id','file-id','file-name','remote-directory','parent-file-id','local-path','source','limit','task-id'].map(k=>[k,{type:'string'}]))};
const readOps=new Set(['doctor','status','instances','regions','gpu-types','machines','instance-info','instance-monitor','instance-connection','images','instance-prepare','image-prepare','provision-catalog','provision-prepare','task-prepare','task-list','task-info','panel-open','panel-read','panel-cloud','notifications']);
const executeOps=new Set(['instance-execute','image-execute','provision-execute','task-start']);
const panelWrites=new Set(['panel-transfer','panel-task']);
const credentialKeys=/password|token|authorization|credential|secret|private.?key/i;
const help=`AutoDL 本地 HTTP CLI · Node.js 20.17+ · 无 npm 依赖

bash ./fo                      本地交互菜单
bash ./fo login [--account 账号]  本机终端隐藏输入密码，登录会话留在内存
bash ./fo doctor --json         检查本地会话
bash ./fo accounts --json       列出本地账号
bash ./fo switch 账号            选择已登录过的账号
bash ./fo logout [--account 账号] 清除所选账号内存会话

fo instances|regions|gpus --json
fo machines --regions 地区1,地区2 [--gpu 型号] [--idle 1] --json
fo instance info|monitor|connection 实例ID --json
fo instance prepare 实例ID 操作 [--name 名称] [--shutdown-at 'YYYY-MM-DD HH:mm'] [--size-gb 额外数据盘目标GB] --json
fo instance execute 计划ID --confirm yes --json
  操作：powerOn powerOff restart rename timedShutdown cancelShutdown saveImage release expandDataDisk
fo image list --json
fo image prepare 镜像ID rename|delete [--name 名称] --json
fo image execute 计划ID --confirm yes --json

fo provision catalog --regions 地区 [--gpu 型号] [--gpu-count 1] [--machine-id ID] --json
fo provision prepare create|clone --data 'JSON配置' --json
fo provision execute 计划ID --confirm yes --json
  配置：machineId,gpuCount,name,dataDiskGB（额外付费GB）,imageUuid（新建）
  克隆改用 sourceInstanceUuid，可加 copyDataDisk；系统盘不扩容。
fo task prepare --data 'JSON条件' --json
fo task start 计划ID --confirm yes --json
  条件：mode=powerOn|create|clone，maxHourly必填；新建/克隆还需地区、GPU、数量及数据盘。
  regionSigns/gpuNames支持多选；dataDiskGB固定额外付费GB与minDataDiskGB最低总容量GB二选一。
  minGpuMemoryGB可选：每张GPU最低显存GB；省略表示不限，不按多卡显存相加。
  新建/克隆跨所选范围主机寻找；已有实例开机绑定原主机，跨主机请用克隆。
  maxMinutes默认60，maxAttempts默认120，intervalSeconds默认30（最少10秒）。
fo task list --json
fo task info 任务ID --json
fo task cancel 任务ID [--confirm yes|no] --json
fo task watch 任务ID            前台跟踪；抢卡本身在本机后台运行
fo notifications [--after 0] --json

fo panel open 实例ID --json
fo panel login 句柄             本机终端隐藏输入独立 AutoPanel 密码
fo panel workdir|accounts|tasks|history 句柄 [--limit 100] --json
fo panel local-files 句柄 --path /实例目录 --json
fo panel cloud-files 句柄 --disk-id 网盘ID [--path /] [--file-id 目录ID] --json
fo panel upload 句柄 --disk-id 网盘ID --local-path /实例文件 [--directory] --json
fo panel download 句柄 --disk-id 网盘ID --file-id 文件ID --file-name 名称 [--directory] --json
  传输可加 --remote-directory /网盘目录 --parent-file-id 目录ID --source resource|backup
  无 --confirm 仅预览；用户确认后加 --confirm yes；--confirm no 取消
fo panel cancel 句柄 --task-id 任务ID [--confirm yes|no] --json
fo panel clear 句柄 [--confirm yes|no] --json
fo panel watch 句柄             持续进度、终端和本地桌面结果提醒

fo api 操作 --data '{"参数":"值"}' --json [--confirm yes|no]
  支持上述接口对应的读取、预览和执行操作；凭据仅通过 login 输入。

Codex：先 doctor 检查登录，按 docs/codex.md 操作。先展示计划和费用，获得用户 yes 后才执行。
密码在你自己的终端输入，不放入聊天、参数或 JSON。平台额外验证会明确报错，不自动打开浏览器。
旧远程部署只通过 fo remote ... 显式使用。`;

function tty(){if(!process.stdin.isTTY||!process.stdout.isTTY)throw fail('TTY_REQUIRED','请在自己的本机终端运行 bash ./fo login；账号密码在终端输入，密码不回显。');}
function required(value,label){if(typeof value!=='string'||!value.trim())throw fail('USAGE',`缺少${label}，使用 bash ./fo help 查看用法`);return value;}
function integer(value,fallback,label){if(value===undefined)return fallback;const n=Number(value);if(!Number.isSafeInteger(n)||n<1)throw fail('USAGE',`${label}需为正整数`);return n;}
function confirmation(value){if(value!==undefined&&!['yes','no'].includes(value))throw fail('USAGE','--confirm 只能是 yes 或 no');return value;}
function dataJSON(value){let data;try{data=JSON.parse(value||'{}');}catch{throw fail('INVALID_REQUEST','--data 需要 JSON 对象');}if(!data||Array.isArray(data)||typeof data!=='object')throw fail('INVALID_REQUEST','--data 需要 JSON 对象');return data;}
function inspectData(value){
 if(Array.isArray(value)){for(const v of value)inspectData(v);return;}
 if(!value||typeof value!=='object')return;
 for(const [key,v] of Object.entries(value)){
  if(credentialKeys.test(key))throw fail('CREDENTIALS_IN_ARGUMENTS','凭据请通过本机终端的 login 命令输入');
  if(['account','tenant','socket','op','__proto__','prototype','constructor'].includes(key))throw fail('INVALID_REQUEST','请求包含不支持的控制字段，请用 --account 选择账号');
  inspectData(v);
 }
 if(value.includeSecrets)throw fail('INVALID_REQUEST','机器接口只返回脱敏连接信息；显示密码请使用本地交互菜单');
}
async function context(options){
 const c=await connectLocal({username:options.account});
 if(!c.client.identity)throw fail('LOGIN_REQUIRED','本地账号未登录或会话已结束，请在自己的终端运行 bash ./fo login');
 return c;
}
async function login(options){
 tty();if(options.json)throw fail('TTY_REQUIRED','请用不带 --json 的 bash ./fo login 在自己的终端输入账号密码');
 const saved=await listLocalAccounts();
 const username=options.account||(await ask(`AutoDL 子账号${saved.current?' ['+saved.current+']':''}：`))||saved.current;
 required(username,'AutoDL 子账号');let password=await secret('密码（不回显）：');
 try{const c=await loginLocal(username,password);console.log(`本地登录成功：${c.username}。会话保存在本机内存；没有活动抢卡任务时空闲 30 分钟退出，logout 后需重新登录。`);return c;}
 finally{password=undefined;}
}
async function invoke(request,options,{kind='read'}={}){
 const confirm=confirmation(options.confirm);
 if(kind!=='read'){
  if(confirm==='no')return {state:'cancelled'};
  if(request.op==='panel-transfer'){
   const c=await context(options),summary=await transferPreview(c.request,request);
   if(confirm!=='yes')return {state:'preview',request:{...request,confirmed:false},summary};
   return c.request({...request,confirmed:true});
  }
  if(confirm!=='yes'){
   if(kind==='execute')throw fail('CONFIRMATION_REQUIRED','请先向用户展示预览及费用，收到 yes 后使用 --confirm yes');
   return {state:'preview',request:{...request,confirmed:false}};
  }
  request={...request,confirmed:true};
 }
 const c=['task-list','task-info','notifications'].includes(request.op)?await connectLocal({username:options.account}):await context(options);
 return c.request(request);
}
async function watchTask(taskId,options){
 if(options.json)throw fail('TTY_REQUIRED','task watch 持续输出进度，请不带 --json；机器查询请用 task info');
 tty();const controller=new AbortController(),stop=()=>controller.abort();process.on('SIGINT',stop);let last;
 try{
  for(;;){
   const result=await invoke({op:'task-info',taskId},options),key=JSON.stringify([result.state,result.attempts,result.errorCode,result.instanceUuid]);
   if(key!==last){console.dir(result,{depth:5});last=key;}
   if(!['waiting','quoting','submitting','verifying'].includes(result.state)||controller.signal.aborted)return {stopped:true};
   try{await sleep(5000,undefined,{signal:controller.signal});}catch(error){if(error.name!=='AbortError')throw error;return {stopped:true};}
  }
 }finally{process.removeListener('SIGINT',stop);}
}
async function transferPreview(request,q){
 if(!['upload','download'].includes(q.direction))throw fail('INVALID_REQUEST','请选择上传或下载');
 required(q.handle,'AutoPanel 句柄');required(q.diskId,'网盘ID');
 const source=q.source||'resource',remoteDirectory=q.remoteDirectory||'/';
 if(!['resource','backup'].includes(source)||typeof remoteDirectory!=='string'||!remoteDirectory.startsWith('/')||remoteDirectory.includes('\0')||remoteDirectory.split('/').some(p=>p==='.'||p==='..'))throw fail('PATH_REQUIRED','请选择有效的网盘空间和绝对目录');
 const accounts=await request({op:'panel-read',handle:q.handle,query:'accounts'}),account=accounts.find(a=>a.fs_id===q.diskId);
 if(account?.type!=='AutoDL_AliPan')throw fail('DISK_UNSUPPORTED','当前传输只支持当前实例已授权的阿里云盘');
 const cloud=()=>request({op:'panel-cloud',handle:q.handle,diskId:q.diskId,args:{path:remoteDirectory,fileId:q.parentFileId,source}});
 const local=path=>request({op:'panel-read',handle:q.handle,query:'localFiles',path});
 if(q.direction==='upload'){
  const path=required(q.localPath,'实例文件路径');
  if(!path.startsWith('/')||path.endsWith('/')||path.includes('\0')||path.split('/').some(p=>p==='.'||p==='..'))throw fail('PATH_REQUIRED','请输入实例文件或目录的绝对路径，不带末尾斜杠');
  const split=path.lastIndexOf('/'),name=path.slice(split+1),file=(await local(path.slice(0,split)||'/')).find(f=>f.filename===name);
  if(!file||!!file.is_dir!==(q.isDirectory===true))throw fail('FILE_REQUIRED','源文件已变化或类型不符；目录传输需明确使用 --directory');
  if((await cloud()).some(f=>f.name===name))throw fail('FILE_EXISTS','网盘目标已有同名文件或目录，请重新选择目标');
  return {direction:'upload',source:path,destination:`阿里云盘 ${source} ${remoteDirectory.replace(/\/$/,'')}/${name}`,isDirectory:!!file.is_dir,bytes:file.size_in_byte??null};
 }
 const file=(await cloud()).find(f=>f.file_id===q.fileId&&f.name===q.fileName);
 if(!file||!!file.is_dir!==(q.allowDirectory===true))throw fail('FILE_REQUIRED','网盘文件已变化或类型不符，请重新查询并选择');
 const workdir=await request({op:'panel-read',handle:q.handle,query:'workdir'});
 if((await local(workdir)).some(f=>f.filename===file.name))throw fail('FILE_EXISTS','实例下载目录已有同名文件或目录，请重新选择');
 return {direction:'download',source:`阿里云盘 ${source} ${remoteDirectory.replace(/\/$/,'')}/${file.name}`,destination:workdir.replace(/\/$/,'')+'/'+file.name,isDirectory:!!file.is_dir,bytes:file.size??null};
}
async function panelCommand(action,handle,options){
 required(handle,action==='open'?'实例ID':'AutoPanel 句柄');
 if(action==='open')return invoke({op:'panel-open',instanceUuid:handle},options);
 if(action==='login'){
  tty();if(options.json)throw fail('TTY_REQUIRED','请用不带 --json 的 fo panel login 句柄输入独立密码');
  const c=await context(options);let password=await secret('AutoPanel 独立密码（不回显）：');
  try{const result=await c.request({op:'panel-login',handle,password});console.log('AutoPanel 本地登录成功。');return result;}finally{password=undefined;}
 }
 if(action==='watch'){
  if(options.json)throw fail('TTY_REQUIRED','watch 持续显示进度，请在自己的终端运行 fo panel watch 句柄，不带 --json；机器查询请用 panel tasks 或 panel history');
  tty();const c=await context(options);await followTransfers({taskHistory:(limit=100)=>c.request({op:'panel-read',handle,query:'taskHistory',limit})});return {stopped:true};
 }
 const queries={'workdir':'workdir','local-files':'localFiles',accounts:'accounts',tasks:'activeTasks',history:'taskHistory'};
 if(Object.hasOwn(queries,action))return invoke({op:'panel-read',handle,query:queries[action],...(action==='local-files'?{path:required(options.path,'实例目录路径')} :{}),...(action==='history'?{limit:integer(options.limit,100,'记录数量')}: {})},options);
 if(action==='cloud-files')return invoke({op:'panel-cloud',handle,diskId:required(options['disk-id'],'网盘ID'),args:{path:options.path||'/',fileId:options['file-id'],source:options.source||'resource'}},options);
 if(['cancel','clear'].includes(action))return invoke({op:'panel-task',handle,action,...(action==='cancel'?{taskId:required(options['task-id'],'任务ID')}:{})},options,{kind:'mutation'});
 if(['upload','download'].includes(action)){
  const q={op:'panel-transfer',handle,direction:action,diskId:required(options['disk-id'],'网盘ID'),source:options.source||'resource',remoteDirectory:options['remote-directory']||'/',parentFileId:options['parent-file-id']};
  if(!['resource','backup'].includes(q.source))throw fail('USAGE','网盘空间需为 resource 或 backup');
  if(action==='upload'){q.localPath=required(options['local-path'],'实例文件路径');if(options.directory)q.isDirectory=true;}
  else {q.fileId=required(options['file-id'],'网盘文件ID');q.fileName=required(options['file-name'],'网盘文件名');if(options.directory)q.allowDirectory=true;}
  return invoke(q,options,{kind:'mutation'});
 }
 throw fail('USAGE','不支持的 AutoPanel 子命令，使用 fo help 查看用法');
}
async function dispatch(words,options){
 const [command,action,id,operation]=words;
 if(options.help||['help','--help','-h'].includes(command))return {help};
 if(!command||['local','http'].includes(command)){
  if(options.json)throw fail('TTY_REQUIRED','交互菜单不支持 --json；请使用明确的子命令，例如 doctor --json');
  tty();let c;
  try{c=await context(options);}catch(error){if(error.code!=='LOGIN_REQUIRED'&&error.code!=='LOCAL_SESSION_CLOSED')throw error;c=await login(options);}
  await menu({client:c.client,sessionDescription:'会话仅在本机内存中；无需远程服务器。退出登录用 fo logout。'});return {closed:true};
 }
 if(command==='login'){const c=await login(options);return {authenticated:true,username:c.username};}
 if(command==='accounts')return listLocalAccounts();
 if(command==='switch'){
  const username=required(action,'账号'),saved=await listLocalAccounts();if(!saved.accounts.some(a=>a.username===username))throw fail('ACCOUNT_REQUIRED','请先用 fo login --account 账号 登录此账号');
  await selectLocalAccount(username);return {current:username};
 }
 if(command==='logout')return logoutLocal({username:options.account});
 if(command==='doctor'){
  const saved=await listLocalAccounts(),username=options.account||saved.current;
  if(!username)return {mode:'local',authenticated:false,current:null,remoteServer:false};
  try{const c=await connectLocal({username,start:false});return {...c.health,transport:'本机私有 Unix socket + AutoDL HTTP',mode:'local',current:username,remoteServer:false};}
  catch(error){if(!['LOCAL_SESSION_CLOSED','LOGIN_REQUIRED','NETWORK'].includes(error.code))throw error;return {mode:'local',authenticated:false,current:username,remoteServer:false};}
 }
 const reads={instances:'instances',regions:'regions',gpus:'gpu-types'};
 if(Object.hasOwn(reads,command))return invoke({op:reads[command]},options);
 if(command==='machines')return invoke({op:'machines',args:{regionSigns:required(options.regions,'--regions').split(',').filter(Boolean),gpuNames:options.gpu?options.gpu.split(','):[],idle:integer(options.idle,1,'空闲卡数量')}},options);
 if(command==='notifications')return invoke({op:'notifications',after:options.after===undefined?0:Number(options.after)},options);
 if(command==='provision'){
  if(action==='catalog')return invoke({op:'provision-catalog',args:{regionSigns:options.regions?options.regions.split(',').filter(Boolean):[],gpuNames:options.gpu?options.gpu.split(','):[],gpuCount:integer(options['gpu-count'],1,'GPU数量'),...(options['machine-id']?{machineId:required(options['machine-id'],'机器ID')}:{})}},options);
  if(action==='prepare'){const data=dataJSON(options.data);inspectData(data);return invoke({op:'provision-prepare',mode:required(id,'create 或 clone'),args:data},options);}
  if(action==='execute')return invoke({op:'provision-execute',planId:required(id,'计划ID')},options,{kind:'execute'});
  throw fail('USAGE','provision 支持 catalog、prepare、execute');
 }
 if(command==='task'){
  if(action==='prepare'){const data=dataJSON(options.data);inspectData(data);return invoke({op:'task-prepare',policy:data},options);}
  if(action==='start')return invoke({op:'task-start',planId:required(id,'计划ID')},options,{kind:'execute'});
  if(action==='list')return invoke({op:'task-list'},options);
  if(action==='info')return invoke({op:'task-info',taskId:required(id,'任务ID')},options);
  if(action==='cancel')return invoke({op:'task-cancel',taskId:required(id,'任务ID')},options,{kind:'mutation'});
  if(action==='watch')return watchTask(required(id,'任务ID'),options);
  throw fail('USAGE','task 支持 prepare、start、list、info、cancel、watch');
 }
 if(['instance','image'].includes(command)){
  if(command==='image'&&action==='list')return invoke({op:'images'},options);
  required(id,action==='execute'?'计划ID':command==='instance'?'实例ID':'镜像ID');
  if(command==='instance'&&['info','monitor','connection'].includes(action))return invoke({op:'instance-'+action,instanceUuid:id},options);
  if(action==='prepare')return invoke({op:command+'-prepare',...(command==='instance'?{instanceUuid:id}:{imageUuid:id}),action:required(operation,'操作'),args:{...(options.name!==undefined?{name:options.name}:{}),...(options['shutdown-at']!==undefined?{shutdownAt:options['shutdown-at']}:{}) ,...(options['size-gb']!==undefined?{sizeGB:integer(options['size-gb'],undefined,'额外数据盘目标GB')}:{})}},options);
  if(action==='execute')return invoke({op:command+'-execute',planId:id},options,{kind:'execute'});
  throw fail('USAGE','不支持的子命令，使用 fo help 查看用法');
 }
 if(command==='panel')return panelCommand(action,id,options);
 if(command==='api'){
  const op=required(action,'操作');if(!readOps.has(op)&&!executeOps.has(op)&&!panelWrites.has(op)&&op!=='task-cancel')throw fail('UNSUPPORTED_OPERATION','此操作不支持机器接口；登录请使用终端 login');
  const data=dataJSON(options.data);inspectData(data);
  return invoke({...data,op},options,{kind:executeOps.has(op)?'execute':panelWrites.has(op)||op==='task-cancel'?'mutation':'read'});
 }
 throw fail('USAGE','不支持的命令，使用 bash ./fo help 查看用法');
}
export async function runLocal(args=process.argv.slice(2)){
 let options={json:args.includes('--json')};
 try{
  let parsed;try{parsed=parseArgs({args,options:flags,allowPositionals:true,strict:true});}catch{throw fail('USAGE','参数格式错误，使用 bash ./fo help 查看用法');}
  options=parsed.values;confirmation(options.confirm);
  const result=await dispatch(parsed.positionals,options);
  if(options.json)console.log(JSON.stringify({ok:true,result}));
  else if(result?.help)console.log(result.help);
  else if(!['login','panel'].includes(parsed.positionals[0])&&!(parsed.positionals[0]==='task'&&parsed.positionals[1]==='watch')&&parsed.positionals.length)console.dir(result,{depth:8});
  else if(parsed.positionals[0]==='panel'&&parsed.positionals[1]!=='login'&&parsed.positionals[1]!=='watch')console.dir(result,{depth:8});
  return result;
 }catch(error){
  const code=typeof error.code==='string'?error.code:'INTERNAL_ERROR',message=code==='INTERNAL_ERROR'?'本地程序遇到错误，请检查运行环境':error.message;
  if(options.json)console.log(JSON.stringify({ok:false,code,error:message}));else console.error(`${code}：${message}`);
  process.exitCode=['USAGE','INVALID_REQUEST','CREDENTIALS_IN_ARGUMENTS','CONFIRMATION_REQUIRED','TTY_REQUIRED'].includes(code)?2:1;
 }
}
if(isMain(import.meta.url))await runLocal();
