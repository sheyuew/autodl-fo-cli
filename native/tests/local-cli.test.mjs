import test from 'node:test';import assert from 'node:assert/strict';import{createServer}from'node:http';import{once}from'node:events';import{mkdtemp,readdir,readFile,rm}from'node:fs/promises';import{tmpdir}from'node:os';import{join,resolve}from'node:path';import{execFile}from'node:child_process';import{promisify}from'node:util';import{runTerminal}from'./terminal-utils.mjs';
const loaded=await import('../local-cli.mjs').catch(e=>{if(e.code==='ERR_MODULE_NOT_FOUND')return {};throw e;});const exec=promisify(execFile),entry=resolve('native/local-cli.mjs');
async function fixture(t){
 assert.equal(typeof loaded.runLocal,'function','Local machine-readable CLI is not implemented');
 const home=await mkdtemp(join(tmpdir(),'fo-cli-local-')),seen=[],state={collision:false},row={uuid:'one',name:'own-instance',status:'running',has_auto_panel:true,root_password:'private-root',jupyter_token:'private-outer'};
 const server=createServer(async(q,r)=>{let raw='';for await(const p of q)raw+=p;const body=raw?JSON.parse(raw):{};seen.push({path:q.url,method:q.method,body});let data,code='Success';
 if(q.url==='/api/v1/sub_user/login'){assert.equal(body.password,'b1b3773a05c0ed0176787a4f1574ff0075f7521e');data={ticket:body.sub_name,user:{id:1,sub_name:body.sub_name}};}
 else if(q.url==='/api/v1/sub_user/passport')data={token:'private-token-'+body.ticket};
 else if(q.url==='/api/v1/sub_user/instance')data={list:[row],result_total:1};
 else if(q.url==='/api/v1/sub_user/instance/name'){assert.equal(q.method,'PUT');data=null;}
 else if(q.url==='/api/v1/sub_user/image/private/list')data={list:[],result_total:0};
 else if(q.url.startsWith('/autopanel/v1/')){
  code='success';const u=new URL(q.url,'http://fixture');assert.equal(q.headers.autodlautopaneltoken,'private-outer');
  if(u.pathname.endsWith('/sign_in'))data='private-panel-token';
  else{assert.equal(q.headers.authorization,'private-panel-token');
   if(u.pathname.endsWith('/netdisk/list'))data=[{fs_id:'disk',type:'AutoDL_AliPan',user_info:{resource_drive_id:'drive'}}];
   else if(u.pathname==='/autopanel/v1/file')data=[{filename:'results',is_dir:true}];
   else if(u.pathname.endsWith('/netdisk/file'))data={list:{List:state.collision?[{name:'results',file_id:'exists',is_dir:true}]:[]},next_marker:''};
   else if(u.pathname.endsWith('/netdisk/upload'))data={task_id:'transfer-one'};
   else assert.fail('Unexpected panel operation '+q.url);
  }
 }
 else assert.fail('Unexpected provider operation '+q.url);
 r.end(JSON.stringify({code,data}));});server.listen(0,'127.0.0.1');await once(server,'listening');
 row.proxy_host='127.0.0.1';row.jupyter_port=server.address().port;
 const baseUrl=`http://127.0.0.1:${server.address().port}`,env={...process.env,FO_LOCAL_HOME:home,AUTODL_WEB_ORIGIN:baseUrl};
 const run=async(...args)=>{try{const p=await exec(process.execPath,[entry,...args],{env,timeout:15000});return{code:0,...p,json:JSON.parse(p.stdout)};}catch(e){return {code:e.code,stdout:e.stdout||'',stderr:e.stderr||'',json:e.stdout?JSON.parse(e.stdout):null};}};
 t.after(async()=>{try{const {logoutLocal,listLocalAccounts}=await import('../local-session.mjs');for(const a of (await listLocalAccounts({home})).accounts)await logoutLocal({home,username:a.username});}finally{server.closeAllConnections();server.close();await rm(home,{recursive:true,force:true});}});
 const login=async()=>{const p=await runTerminal({entry,args:['login'],env,baseUrl,steps:[{wait:'AutoDL 子账号',send:'alice@team\n'},{wait:'密码',send:'qwerty\n'}]},t);assert.equal(p.code,0,p.error);for(const secret of ['qwerty','private-token','private-root'])assert.ok(!p.output.includes(secret),secret);return p;};
 const openPanel=async()=>{const p=await run('panel','open','one','--json');assert.equal(p.code,0,p.stderr);const handle=p.json.result.handle;const session=await runTerminal({entry,args:['panel','login',handle],env,baseUrl,steps:[{wait:'AutoPanel 独立密码',send:'panel-password\n'}]},t);assert.equal(session.code,0,session.error);assert.ok(!session.output.includes('panel-password'));return handle;};
 return {home,seen,env,run,login,openPanel,state};
}
async function diskText(dir){let s='';for(const e of await readdir(dir,{withFileTypes:true})){const path=join(dir,e.name);if(e.isDirectory())s+=await diskText(path);else if(e.isFile())s+=await readFile(path,'utf8');}return s;}

test('fresh local JSON commands report login requirements without a server, invitation, browser, or credential prompt',async t=>{
 const f=await fixture(t);const d=await f.run('doctor','--json');assert.equal(d.code,0,d.stderr);assert.equal(d.json.ok,true);assert.equal(d.json.result.authenticated,false);
 const p=await f.run('instances','--json');assert.notEqual(p.code,0);assert.equal(p.json.code,'LOGIN_REQUIRED');assert.ok(!p.stdout.includes('邀请码'));assert.equal(f.seen.length,0);
});
test('hidden terminal login is reused by separate JSON command processes and stores no provider credentials',async t=>{
 const f=await fixture(t);await f.login();const a=await f.run('instances','--json'),b=await f.run('doctor','--json');assert.equal(a.code,0,a.stderr);assert.equal(a.json.result[0].uuid,'one');assert.equal(b.json.result.authenticated,true);
 const accounts=await f.run('accounts','--json');assert.equal(accounts.json.result.current,'alice@team');assert.equal(f.seen.filter(r=>r.path.endsWith('/login')).length,1);
 const text=await diskText(f.home);for(const secret of ['qwerty','private-token','private-root','private-outer']){assert.ok(!text.includes(secret),secret);assert.ok(!a.stdout.includes(secret),secret);}
});
test('instance preview does not mutate; JSON execution needs explicit yes, preserves no, and submits once',async t=>{
 const f=await fixture(t);await f.login();const p=await f.run('instance','prepare','one','rename','--name','renamed','--json');assert.equal(p.code,0,p.stderr);assert.equal(p.json.result.body.instance_name,'renamed');const id=p.json.result.id;
 const count=()=>f.seen.filter(r=>r.path.endsWith('/instance/name')).length;assert.equal(count(),0);
 const blocked=await f.run('instance','execute',id,'--json');assert.equal(blocked.json.code,'CONFIRMATION_REQUIRED');
 const no=await f.run('instance','execute',id,'--confirm','no','--json');assert.equal(no.json.result.state,'cancelled');assert.equal(count(),0);
 const yes=await f.run('instance','execute',id,'--confirm','yes','--json');assert.equal(yes.json.result.accepted,true);assert.equal(count(),1);
 const repeated=await f.run('instance','execute',id,'--confirm','yes','--json');assert.equal(repeated.json.code,'PLAN_EXPIRED');assert.equal(count(),1);
});
test('raw JSON cannot smuggle credentials, confirmations or a different account into the local API',async t=>{
 const f=await fixture(t);await f.login();const before=f.seen.length;
 for(const [op,data] of [['login-password',{username:'alice@team',password:'blockedfixture'}],['panel-login',{handle:'h',password:'blockedfixture'}],['instances',{token:'blockedfixture'}],['instances',{tenant:'other'}]]){
  const p=await f.run('api',op,'--data',JSON.stringify(data),'--json');assert.notEqual(p.code,0);assert.ok(!p.stdout.includes('blockedfixture'));
 }
 const p=await f.run('api','instance-execute','--data',JSON.stringify({planId:'p',confirmed:true}),'--json');assert.equal(p.json.code,'CONFIRMATION_REQUIRED');assert.equal(f.seen.length,before);
});
test('panel transfer and task commands preview or cancel without network mutations until explicit yes',async t=>{
 const f=await fixture(t);await f.login();const handle=await f.openPanel();const before=f.seen.filter(x=>x.path.endsWith('/netdisk/upload')).length;
 const preview=await f.run('panel','upload',handle,'--disk-id','disk','--local-path','/root/results','--directory','--json');assert.equal(preview.json.result.state,'preview');assert.equal(preview.json.result.request.isDirectory,true);assert.equal(preview.json.result.request.localPath,'/root/results');assert.equal(preview.json.result.summary.source,'/root/results');
 const cancelled=await f.run('panel','cancel',handle,'--task-id','task','--confirm','no','--json');assert.equal(cancelled.json.result.state,'cancelled');assert.equal(f.seen.filter(x=>x.path.endsWith('/netdisk/upload')).length,before);
 const submitted=await f.run('panel','upload',handle,'--disk-id','disk','--local-path','/root/results','--directory','--confirm','yes','--json');assert.equal(submitted.json.result.accepted,true);assert.equal(f.seen.filter(x=>x.path.endsWith('/netdisk/upload')).length,before+1);
});


test('existing cloud targets and nonexistent local sources block transfer before any upload',async t=>{
 const f=await fixture(t);await f.login();const handle=await f.openPanel();f.state.collision=true;
 const args=['panel','upload',handle,'--disk-id','disk','--local-path','/root/results','--directory','--confirm','yes','--json'];
 const collision=await f.run(...args);assert.equal(collision.json.code,'FILE_EXISTS');
 f.state.collision=false;const missing=await f.run('panel','upload',handle,'--disk-id','disk','--local-path','/root/missing','--json');assert.equal(missing.json.code,'FILE_REQUIRED');
 assert.equal(f.seen.filter(x=>x.path.endsWith('/netdisk/upload')).length,0);
});

test('JSON rejects continuous terminal watch before it can print mixed progress output or request credentials',async t=>{
 const f=await fixture(t);const p=await runTerminal({entry,args:['panel','watch','h','--json'],env:f.env,steps:[]},t);assert.equal(p.code,2,p.error);const result=JSON.parse(p.output.trim());assert.equal(result.code,'TTY_REQUIRED');assert.equal(f.seen.length,0);
});
test('malformed transfer paths have a stable public error instead of an internal exception',async t=>{
 const f=await fixture(t);await f.login();const p=await f.run('api','panel-transfer','--data',JSON.stringify({direction:'upload',handle:'h',diskId:'disk',localPath:'/root/results',remoteDirectory:123}),'--json');assert.equal(p.json.code,'PATH_REQUIRED');assert.equal(f.seen.filter(x=>x.path.endsWith('/netdisk/upload')).length,0);
});
