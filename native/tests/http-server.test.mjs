import test from 'node:test';import assert from 'node:assert/strict';
import {createServer as httpServer} from 'node:http';import {createConnection} from 'node:net';
import {once} from 'node:events';import {mkdtemp,readFile,readdir,mkdir,writeFile} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
const loaded=await import('../http-server.mjs').catch(e=>{if(e.code==='ERR_MODULE_NOT_FOUND')return {};throw e;});
async function api(t,{emptyUuid=false}={}){
 const requests=[];const server=httpServer(async(q,r)=>{let raw='';for await(const p of q)raw+=p;const b=raw?JSON.parse(raw):{};requests.push({path:q.url,method:q.method,body:b});let data,code='Success';
 if(q.url.endsWith('/sub_user/login'))data={ticket:b.sub_name,user:{id:123,uuid:emptyUuid?'':'user-'+b.sub_name,sub_name:b.sub_name}};
 else if(q.url.endsWith('/sub_user/passport'))data={token:'web-token-'+b.ticket};
 else if(q.url==='/api/v1/sub_user/instance')data={list:[{uuid:'instance-a',name:'fixture-instance',status:'running',has_auto_panel:true,jupyter_token:'outer-private',proxy_host:'127.0.0.1',jupyter_port:server.address().port,root_password:'root-private',req_gpu_amount:1}],result_total:1};
 else if(q.url==='/api/v1/sub_user/image/private/list')data={list:[{id:42,image_uuid:'image-a',name:'saved',status:'success'}],result_total:1};
 else if(q.url==='/api/v1/sub_user/image/private/update'){data=null;}
 else if(q.url==='/api/v1/sub_user/instance/name'){assert.equal(q.method,'PUT');data=null;}
 else if(q.url==='/api/v1/sub_user/region/list')data=[{visible:'all',used_for:'all',region_name:'Region',region_sign:'region-a'}];
 else if(q.url.startsWith('/autopanel/v1/')){
  code='success';assert.equal(q.headers.autodlautopaneltoken,'outer-private');
  if(q.url.endsWith('/sign_in'))data='panel-private';
  else{assert.equal(q.headers.authorization,'panel-private');
   if(q.url.endsWith('/netdisk/list'))data=[{fs_id:'disk-a',type:'AutoDL_AliPan',refresh_token:'cloud-private',user_info:{resource_drive_id:'drive-a',access_token:'cloud-access-private'}}];
   else if(q.url.startsWith('/autopanel/v1/netdisk/file'))data={list:{List:[{name:'file.bin',file_id:'file-id',size:10,is_dir:false,download_url:'https://fixture.invalid/signed-private'}]},next_marker:''};
   else if(q.url.endsWith('/netdisk/download')){assert.equal(b.download_url,'https://fixture.invalid/signed-private');data={task_id:'task-a'};}
   else if(q.url.startsWith('/autopanel/v1/netdisk/task')&&q.method==='DELETE'){assert.equal(new URL(q.url,'http://fixture').searchParams.get('task_id'),'queued-a');data=null;}
   else if(q.url.endsWith('/netdisk/task/clear'))data=null;
   else if(q.url.startsWith('/autopanel/v1/netdisk/task'))data={task_pre:[{task_id:'queued-a',file_name:'queued.bin'}],task_doing:[],task_done:[{file_name:'file.bin',status:'success',download_url:'signed-private',task_type:2}],task_success:1,task_total:1};
   else if(q.url.endsWith('/workdir'))data='/root/autodl-tmp';
   else if(q.url.startsWith('/autopanel/v1/file'))data=[];
   else assert.fail('unexpected panel request');
  }
 }else assert.fail('unexpected provider request');
 r.end(JSON.stringify({code,data}));});server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{server.closeAllConnections();server.close();});
 return {baseUrl:`http://127.0.0.1:${server.address().port}`,requests};
}
async function service(t,baseUrl,id='alice',existing){
 assert.equal(typeof loaded.startHttpServer,'function','Native HTTP RPC server has not been implemented');
 const state=existing||await mkdtemp(join(tmpdir(),'autodl-http-')),socket=join(state,'control.sock'),logs=[];
 const service=await loaded.startHttpServer({state,socket,tenantId:id,baseUrl,logger:line=>logs.push(line)});t.after(()=>service.close());return {state,socket,logs,close:()=>service.close()};
}
function rpc(socket,request){return new Promise((resolve,reject)=>{const c=createConnection(socket);let data='';c.setEncoding('utf8');c.on('connect',()=>c.end(JSON.stringify(request)+'\n'));c.on('data',chunk=>data+=chunk);c.on('error',reject);c.on('end',()=>{try{resolve(JSON.parse(data));}catch(e){reject(e);}});});}
async function result(socket,request){const r=await rpc(socket,request);assert.equal(r.ok,true,r.error);return r.result;}
const login={op:'login-password',username:'alice@team',password:'fixture-password'};
async function openPanel(socket){const p=await result(socket,{op:'panel-open',instanceUuid:'instance-a'});await result(socket,{op:'panel-login',handle:p.handle,password:'fixture-panel-password'});return p.handle;}

test('native RPC logs in freshly, preserves account binding, and never persists credentials or logs request bodies',async t=>{
 const web=await api(t),s=await service(t,web.baseUrl);assert.equal((await result(s.socket,{op:'doctor'})).authenticated,false);
 const identity=await result(s.socket,login);assert.equal(identity.state,'authenticated');
 assert.equal((await result(s.socket,{op:'doctor'})).backend,'native-http');
 const files=await readdir(s.state);assert.ok(files.includes('account-binding.json'));assert.ok(!files.some(f=>/session|password|token/.test(f)));
 const texts=(await Promise.all(files.filter(f=>f.endsWith('.json')).map(f=>readFile(join(s.state,f),'utf8')))).join('')+s.logs.join('');
 for(const secret of ['fixture-password','web-token-','outer-private'])assert.ok(!texts.includes(secret));
 const other=await rpc(s.socket,{...login,username:'bob@team'});assert.equal(other.code,'ACCOUNT_MISMATCH');
});

test('instance, account, cloud file and history replies strip provider secrets at the server boundary',async t=>{
 const web=await api(t),s=await service(t,web.baseUrl);await result(s.socket,login);
 const instances=await result(s.socket,{op:'instances'});assert.equal(instances[0].uuid,'instance-a');assert.equal(instances[0].has_auto_panel,true);
 const handle=await openPanel(s.socket),accounts=await result(s.socket,{op:'panel-read',handle,query:'accounts'});
 const files=await result(s.socket,{op:'panel-cloud',handle,diskId:accounts[0].fs_id,args:{path:'/'}});
 const history=await result(s.socket,{op:'panel-read',handle,query:'taskHistory'});
 assert.equal(files[0].name,'file.bin');assert.equal(history.task_done[0].status,'success');
 const serialized=JSON.stringify({instances,accounts,files,history});for(const value of ['private','download_url','jupyter_token','root_password','refresh_token','access_token'])assert.ok(!serialized.includes(value),value);
});

test('separate tenant sockets cannot use one another\'s panel handles or select another tenant through RPC',async t=>{
 const web=await api(t),a=await service(t,web.baseUrl),b=await service(t,web.baseUrl,'bob');await result(a.socket,login);await result(b.socket,{...login,username:'bob@team'});
 const handle=await openPanel(a.socket);const crossed=await rpc(b.socket,{op:'panel-read',handle,query:'accounts'});assert.equal(crossed.code,'PANEL_REQUIRED');
 const spoofed=await rpc(a.socket,{op:'doctor',tenant:'bob'});assert.equal(spoofed.code,'INVALID_REQUEST');
 assert.equal((await result(a.socket,{op:'doctor'})).identity.username,'alice@team');assert.equal((await result(b.socket,{op:'doctor'})).identity.username,'bob@team');
});

test('paid legacy operations and arbitrary panel endpoints never reach the provider',async t=>{
 const web=await api(t),s=await service(t,web.baseUrl);await result(s.socket,login);const count=web.requests.length;
 for(const op of ['prepare','start','activate','viewer'])assert.equal((await rpc(s.socket,{op})).code,'UNSUPPORTED_OPERATION');
 const handle=await openPanel(s.socket),afterOpen=web.requests.length;
 assert.equal((await rpc(s.socket,{op:'panel-read',handle,query:'clearTask'})).code,'READ_ONLY');assert.equal(web.requests.length,afterOpen);assert.ok(afterOpen>count);
});

test('download uses server-resolved metadata and sends exactly one request after confirmation',async t=>{
 const web=await api(t),s=await service(t,web.baseUrl);await result(s.socket,login);const handle=await openPanel(s.socket);
 const request={op:'panel-transfer',handle,direction:'download',diskId:'disk-a',remoteDirectory:'/',fileId:'file-id',fileName:'file.bin'};
 assert.equal((await rpc(s.socket,request)).code,'CONFIRMATION_REQUIRED');
 const receipt=await result(s.socket,{...request,confirmed:true,download_url:'https://attacker.invalid/ignored'});assert.deepEqual(receipt,{accepted:true,taskId:'task-a'});
 assert.equal(web.requests.filter(x=>x.path.endsWith('/netdisk/download')).length,1);
});

test('service restart retains binding but requires a new login, rather than importing browser storage',async t=>{
 const web=await api(t),a=await service(t,web.baseUrl);await result(a.socket,login);await a.close();
 const b=await service(t,web.baseUrl,'alice',a.state);assert.equal((await result(b.socket,{op:'doctor'})).authenticated,false);
 assert.equal((await rpc(b.socket,{op:'instances'})).code,'LOGIN_REQUIRED');
 assert.equal((await rpc(b.socket,{...login,username:'bob@team'})).code,'ACCOUNT_MISMATCH');
 await result(b.socket,login);assert.equal((await result(b.socket,{op:'instances'})).length,1);
});

test('a verified subaccount with an empty UUID retains the legacy parent-and-login account binding',async t=>{
 const web=await api(t,{emptyUuid:true}),state=await mkdtemp(join(tmpdir(),'fo-binding-'));
 await writeFile(join(state,'account-binding.json'),JSON.stringify({account:'team:alice@team',boundAt:'fixture'}));
 const s=await service(t,web.baseUrl,'alice',state),reply=await rpc(s.socket,login);
 assert.equal(reply.ok,true,reply.error);assert.equal(reply.result.account,'team:alice@team');
 assert.equal((await result(s.socket,{op:'status'})).account,'team:alice@team');
 assert.equal(JSON.parse(await readFile(join(state,'account-binding.json'),'utf8')).boundAt,'fixture');
});


test('instance confirmation plans stay within a tenant and only execute once after explicit confirmation',async t=>{
 const web=await api(t),a=await service(t,web.baseUrl),b=await service(t,web.baseUrl,'bob');await result(a.socket,login);await result(b.socket,{...login,username:'bob@team'});
 const p=await result(a.socket,{op:'instance-prepare',action:'rename',instanceUuid:'instance-a',args:{name:'new'}});
 assert.equal(web.requests.filter(r=>r.path.endsWith('/instance/name')).length,0);
 assert.equal((await rpc(b.socket,{op:'instance-execute',planId:p.id,confirmed:true})).code,'PLAN_EXPIRED');
 assert.equal((await rpc(a.socket,{op:'instance-execute',planId:p.id})).code,'CONFIRMATION_REQUIRED');
 assert.equal((await result(a.socket,{op:'instance-execute',planId:p.id,confirmed:true})).accepted,true);
 assert.equal((await rpc(a.socket,{op:'instance-execute',planId:p.id,confirmed:true})).code,'PLAN_EXPIRED');
 assert.equal(web.requests.filter(r=>r.path.endsWith('/instance/name')).length,1);
});


test('image plans and task controls are available over the real socket and require their own confirmations',async t=>{
 const web=await api(t),s=await service(t,web.baseUrl);await result(s.socket,login);
 const images=await result(s.socket,{op:'images'});assert.equal(images[0].image_uuid,'image-a');
 const plan=await result(s.socket,{op:'image-prepare',action:'rename',imageUuid:'image-a',args:{name:'new'}});
 assert.equal((await rpc(s.socket,{op:'image-execute',planId:plan.id})).code,'CONFIRMATION_REQUIRED');await result(s.socket,{op:'image-execute',planId:plan.id,confirmed:true});
 assert.equal((await rpc(s.socket,{op:'image-prepare',action:'delete',imageUuid:'not-mine'})).code,'IMAGE_REQUIRED');
 const handle=await openPanel(s.socket);
 assert.equal((await rpc(s.socket,{op:'panel-task',handle,action:'cancel',taskId:'queued-a'})).code,'CONFIRMATION_REQUIRED');
 await result(s.socket,{op:'panel-task',handle,action:'cancel',taskId:'queued-a',confirmed:true});
 assert.equal((await rpc(s.socket,{op:'panel-task',handle,action:'clear'})).code,'CONFIRMATION_REQUIRED');await result(s.socket,{op:'panel-task',handle,action:'clear',confirmed:true});
 assert.equal(web.requests.filter(x=>x.method==='DELETE'&&x.path.includes('/task?')).length,1);assert.equal(web.requests.filter(x=>x.path.endsWith('/task/clear')).length,1);
});
