import {createServer} from 'node:net';import {randomUUID} from 'node:crypto';
import {mkdir,readFile,writeFile,rename,unlink,chmod} from 'node:fs/promises';import {join} from 'node:path';
import {loginSubaccount} from './login.mjs';import {WebClient} from './web-client.mjs';import {PanelClient} from './panel-client.mjs';
import {isMain} from './is-main.mjs';
const fail=(code,message)=>Object.assign(new Error(message),{code});
const pick=(value,keys)=>Object.fromEntries(keys.filter(k=>value?.[k]!==undefined).map(k=>[k,value[k]]));
async function readJSON(path,fallback){try{return JSON.parse(await readFile(path,'utf8'));}catch(e){if(e.code==='ENOENT')return fallback;throw e;}}
async function saveJSON(path,value){const temp=path+'.'+randomUUID()+'.tmp';await writeFile(temp,JSON.stringify(value)+'\n',{mode:0o600});await rename(temp,path);}
const fileKeys=['name','is_dir','size','file_id','updated_at'];
const taskKeys=['task_id','task_type','file_name','status','created_at','begin_at','done_at','size','file_size','avg_speed'];
function safeTask(task){return {...pick(task,taskKeys),...(task?.progress?{progress:pick(task.progress,['current','total','rate'])}:{})};}
function safeTasks(data){return {...pick(data,['task_success','task_total']),...Object.fromEntries(['task_pre','task_doing','task_done'].filter(k=>Array.isArray(data[k])).map(k=>[k,data[k].map(safeTask)]))};}

class HttpRuntime{
  #client;#account;#panels=new Map();
  constructor({state,tenantId,baseUrl}){Object.assign(this,{state,tenantId,baseUrl});}
  requireClient(){if(!this.#client)throw fail('LOGIN_REQUIRED','AutoDL 未登录，请在终端登录');return this.#client;}
  panel(handle){const panel=this.#panels.get(handle);if(!panel)throw fail('PANEL_REQUIRED','请重新选择 AutoPanel 实例');return panel;}
  async account(panel,id){const account=(await panel.accounts()).find(a=>a.fs_id===id);if(!account)throw fail('DISK_REQUIRED','网盘不属于当前实例或尚未授权');return account;}
  async dispatch(q){
    if(!q||typeof q!=='object'||Array.isArray(q)||['tenant','socket','account'].some(k=>Object.hasOwn(q,k)))throw fail('INVALID_REQUEST','不能通过请求切换服务器账号');
    if(q.op==='doctor')return {tenant:this.tenantId,backend:'native-http',transport:'SSH + private Unix socket + AutoDL HTTP',authenticated:!!this.#client,identity:this.#client?.identity||null,fo:false,capabilities:['instances','stock','autopanel','ali-file-transfer'],taskEngine:false};
    if(q.op==='notifications'){
      const data=await readJSON(join(this.state,'notifications.json'),{events:[],nextSeq:1});const after=q.after??0;
      if(!Number.isSafeInteger(after)||after<0)throw fail('INVALID_REQUEST','通知游标无效');return {tenant:this.tenantId,events:(data.events||[]).filter(e=>e.seq>after),cursor:(data.nextSeq||1)-1,truncated:false,error:null};
    }
    if(q.op==='login-password'){
      const username=typeof q.username==='string'?q.username.trim():'';
      if(!username||username.length>200||typeof q.password!=='string'||!q.password||q.password.length>512)throw fail('CREDENTIALS_REQUIRED','请输入有效的子账号和密码');
      const bound=await readJSON(join(this.state,'account-binding.json'),null),saved=await readJSON(join(this.state,'login-identity.json'),null);
      if(bound&&saved?.username&&saved.username!==username)throw fail('ACCOUNT_MISMATCH','该服务器环境已绑定其他账号，请切换连接');
      const session=await loginSubaccount({username,password:q.password},{baseUrl:this.baseUrl});
      const subName=session.user.sub_name||'',primary=`${session.user.uuid||session.user.id}:${subName}`;
      // The browser stores the parent's UUID; the subaccount login may return an
      // empty UUID and the child's numeric ID. Both include the verified login.
      const legacy=subName?`${subName.slice(subName.lastIndexOf('@')+1)}:${subName}`:primary;
      if(bound&&![primary,legacy].includes(bound.account))throw fail('ACCOUNT_MISMATCH','登录账号与该环境绑定账号不符');
      const account=bound?.account||legacy;this.#account=account;
      this.#client=new WebClient({session,expectedUsername:username,baseUrl:this.baseUrl});this.#panels.clear();
      if(!bound)await saveJSON(join(this.state,'account-binding.json'),{account,boundAt:new Date().toISOString()});
      await saveJSON(join(this.state,'login-identity.json'),{username});
      return {state:'authenticated',account,identity:this.#client.identity,backend:'native-http'};
    }
    if(['prepare','start','activate','viewer','login','result'].includes(q.op))throw fail('UNSUPPORTED_OPERATION','HTTP 版本提供查询和网盘传输，尚未提供抢卡任务或远程浏览器');
    const client=this.requireClient();
    if(q.op==='status')return {account:this.#account,identity:client.identity,backend:'native-http',fo:false,tasks:[],taskEngine:false};
    if(q.op==='instances'||q.op==='catalog'&&q.query==='instances')return (await client.instances()).map(r=>pick(r,['uuid','name','status','has_auto_panel','snapshot_gpu_alias_name','gpu_name','req_gpu_amount','region_sign','start_mode']));
    if(q.op==='regions')return client.regions();
    if(q.op==='gpu-types')return (await client.gpuTypes()).map(r=>pick(r,['gpu_name','chip_corp','cpu_arch']));
    if(q.op==='machines')return (await client.machines(q.args||{})).map(r=>pick(r,['gpu_name','region_sign','gpu_idle_num','gpu_num','driver_version']));
    if(q.op==='panel-open'){
      const row=(await client.instances()).find(r=>r.uuid===q.instanceUuid);if(!row)throw fail('INSTANCE_REQUIRED','实例不属于当前账号');
      if(this.#panels.size>=20)this.#panels.delete(this.#panels.keys().next().value);
      const handle=randomUUID();this.#panels.set(handle,new PanelClient({instance:row}));return {handle};
    }
    const panel=this.panel(q.handle);
    if(q.op==='panel-login'){await panel.signIn(q.password);return {authenticated:true};}
    if(q.op==='panel-read'){
      if(q.query==='workdir')return panel.workdir();
      if(q.query==='localFiles')return (await panel.localFiles(q.path)).map(r=>pick(r,['filename','is_dir','size_in_byte','updated_at']));
      if(q.query==='accounts')return (await panel.accounts()).map(r=>pick(r,['fs_id','type']));
      if(q.query==='activeTasks')return safeTasks(await panel.activeTasks());
      if(q.query==='taskHistory')return safeTasks(await panel.taskHistory());
      throw fail('READ_ONLY','不支持此 AutoPanel 读取操作');
    }
    if(q.op==='panel-cloud')return (await panel.cloudFiles({account:await this.account(panel,q.diskId),...pick(q.args,['path','source','fileId'])})).map(r=>pick(r,fileKeys));
    if(q.op==='panel-transfer'){
      if(q.confirmed!==true)throw fail('CONFIRMATION_REQUIRED','请先核对传输路径并确认 yes/no');
      const account=await this.account(panel,q.diskId),source=q.source||'resource',remoteDirectory=q.remoteDirectory||'/';
      if(q.direction==='upload')return panel.upload({account,source,remoteDirectory,parentFileId:q.parentFileId,localPath:q.localPath,confirmed:true});
      if(q.direction==='download'){
        const file=(await panel.cloudFiles({account,source,path:remoteDirectory,fileId:q.parentFileId})).find(f=>f.file_id===q.fileId&&f.name===q.fileName);
        if(!file)throw fail('FILE_REQUIRED','网盘文件已变化，请重新选择');return panel.download({account,source,remoteDirectory,file,confirmed:true});
      }
      throw fail('INVALID_REQUEST','请选择上传或下载');
    }
    throw fail('UNSUPPORTED_OPERATION','不支持的 HTTP 操作');
  }
}
const operations=new Set(['doctor','status','notifications','login-password','instances','regions','gpu-types','machines','catalog','panel-open','panel-login','panel-read','panel-cloud','panel-transfer']);
const publicCodes=new Set(['LOGIN_REQUIRED','ACCOUNT_MISMATCH','CREDENTIALS_REQUIRED','LOGIN_REJECTED','NETWORK','RATE_LIMITED','API_ERROR','PERMISSION_DENIED','SCHEMA_CHANGED','PANEL_REQUIRED','PANEL_LOGIN_REQUIRED','PANEL_ACCESS_DENIED','PANEL_NOT_INITIALIZED','PANEL_UNAVAILABLE','INVALID_ORIGIN','DISK_REQUIRED','DISK_UNAVAILABLE','DISK_UNSUPPORTED','PATH_REQUIRED','FILE_REQUIRED','CONFIRMATION_REQUIRED','TRANSFER_UNCERTAIN','INSTANCE_REQUIRED','INVALID_REQUEST','READ_ONLY','UNSUPPORTED_OPERATION']);

export async function startHttpServer({state,socket,tenantId='owner',baseUrl='https://www.autodl.com',logger=console.log}){
  await mkdir(state,{recursive:true,mode:0o700});const runtime=new HttpRuntime({state,tenantId,baseUrl});
  await unlink(socket).catch(e=>{if(e.code!=='ENOENT')throw e;});let tail=Promise.resolve();const connections=new Set();
  const server=createServer({allowHalfOpen:true},conn=>{
    connections.add(conn);conn.on('close',()=>connections.delete(conn));conn.on('error',()=>{});conn.setTimeout(180000,()=>conn.destroy());conn.setEncoding('utf8');let input='',done=false;
    conn.on('data',chunk=>{
      if(done)return;input+=chunk;
      if(Buffer.byteLength(input)>128*1024){done=true;conn.end(JSON.stringify({ok:false,code:'INVALID_REQUEST',error:'请求过大'})+'\n');return;}
      if(!input.includes('\n'))return;done=true;let q;
      try{q=JSON.parse(input.slice(0,input.indexOf('\n')));}catch{conn.end(JSON.stringify({ok:false,code:'INVALID_REQUEST',error:'请求格式错误'})+'\n');return;}input='';
      const requestId=randomUUID(),op=operations.has(q?.op)?q.op:'unknown',started=Date.now();
      const work=async()=>{
        try{const result=await runtime.dispatch(q);logger(JSON.stringify({event:'rpc.finished',requestId,op,tenant:tenantId,ok:true,durationMs:Date.now()-started}));conn.end(JSON.stringify({ok:true,result,requestId})+'\n');}
        catch(error){const code=publicCodes.has(error.code)?error.code:'INTERNAL_ERROR';logger(JSON.stringify({event:'rpc.finished',requestId,op,tenant:tenantId,ok:false,code,durationMs:Date.now()-started}));conn.end(JSON.stringify({ok:false,code,error:code==='INTERNAL_ERROR'?'服务器内部错误':error.message,requestId,...(error.retryable!==undefined?{retryable:error.retryable}:{})})+'\n');}
        finally{if(q&&typeof q==='object')q.password=undefined;}
      };
      tail=tail.catch(()=>{}).then(work);
    });
    conn.on('end',()=>{if(!done)conn.end();});
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(socket,resolve);});await chmod(socket,0o600);
  let closing;
  return {close(){return closing??=(async()=>{for(const c of connections)c.destroy();await new Promise(resolve=>server.close(resolve));await tail;await unlink(socket).catch(e=>{if(e.code!=='ENOENT')throw e;});})();}};
}
if(isMain(import.meta.url)&&process.argv[2]==='--help')console.log('AutoDL HTTP Unix RPC 服务；按 Linux 用户隔离，登录会话仅保留在内存。');
else if(isMain(import.meta.url)){
  process.umask(0o077);let tenantId='owner',state='/var/lib/fo-autodl';
  if(process.env.FO_TENANT_CONFIG){const config=JSON.parse(await readFile(process.env.FO_TENANT_CONFIG,'utf8'));if(!/^[a-z][a-z0-9-]{0,23}$/.test(config.id)||config.id==='owner')throw new Error('成员配置无效');tenantId=config.id;state='/var/lib/fo-tenants/'+tenantId;}
  const service=await startHttpServer({state,socket:join(state,'control.sock'),tenantId});console.log('Native HTTP gateway ready');
  for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>void service.close());
}
