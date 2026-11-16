import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createServer as createSocketServer} from 'node:net';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {once} from 'node:events';
import {mkdtemp,readFile,readdir,stat,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';

const moduleUrl=new URL('../local-session.mjs',import.meta.url).href;
const loaded=await import(moduleUrl).catch(error=>{if(error.code==='ERR_MODULE_NOT_FOUND')return {};throw error;});
const password='local-fixture-password-never-save';
const driver=`
const m=await import(${JSON.stringify(moduleUrl)});
let raw='';for await(const part of process.stdin)raw+=part;
const q=JSON.parse(raw);
try {
 let result;
 if(q.op==='login'){const x=await m.loginLocal(q.username,q.password);result={username:x.username,socket:x.socket,health:x.health};}
 else if(q.op==='accounts')result=await m.listLocalAccounts();
 else if(q.op==='select')result=await m.selectLocalAccount(q.username);
 else if(q.op==='logout')result=await m.logoutLocal({username:q.username});
 else {const x=await m.connectLocal({username:q.username,start:q.start!==false});result=q.op==='instances'?await x.client.instances():await x.client.restore();}
 console.log(JSON.stringify({ok:true,result}));
}catch(error){console.log(JSON.stringify({ok:false,code:error.code,message:error.message}));}
`;

async function fixture(t,{idleMs=30000,queryDelayMs=0}={}){
 assert.equal(typeof loaded.loginLocal,'function','Local account session runtime is not implemented');
 const home=await mkdtemp(join(tmpdir(),'fo-local-tests-'));
 const provider=createServer(async(q,r)=>{
  let raw='';for await(const part of q)raw+=part;const body=raw?JSON.parse(raw):{};let data;
  if(q.url==='/api/v1/sub_user/login')data={ticket:body.sub_name,user:{id:1,uuid:'id-'+body.sub_name,sub_name:body.sub_name}};
  else if(q.url==='/api/v1/sub_user/passport')data={token:'fixture-token-secret-'+body.ticket};
  else if(q.url==='/api/v1/sub_user/instance'){
   if(queryDelayMs)await new Promise(resolve=>setTimeout(resolve,queryDelayMs));
   const username=q.headers.authorization?.replace('fixture-token-secret-','');
   data={list:[{uuid:'instance-'+username,name:'belongs-to-'+username,status:'running'}],result_total:1};
  }else {r.statusCode=404;r.end();return;}
  r.end(JSON.stringify({code:'Success',data}));
 });
 provider.listen(0,'127.0.0.1');await once(provider,'listening');
 const env={...process.env,FO_LOCAL_HOME:home,AUTODL_WEB_ORIGIN:`http://127.0.0.1:${provider.address().port}`,FO_LOCAL_IDLE_MS:String(idleMs)};
 const run=q=>new Promise((resolve,reject)=>{
  const p=spawn(process.execPath,['--input-type=module','-e',driver],{env,stdio:['pipe','pipe','pipe']});let out='',err='';
  const timeout=setTimeout(()=>{p.kill();reject(new Error('local command timed out'));},10000);
  p.stdout.on('data',b=>out+=b);p.stderr.on('data',b=>err+=b);p.once('error',reject);
  p.once('close',code=>{clearTimeout(timeout);if(code!==0)return reject(new Error(err||out));try{resolve(JSON.parse(out));}catch{reject(new Error(out+' '+err));}});
  p.stdin.end(JSON.stringify(q));
 });
 t.after(async()=>{
  for(const username of ['alice@team','bob@team'])await run({op:'logout',username}).catch(()=>{});
  provider.closeAllConnections();await new Promise(resolve=>provider.close(resolve));await rm(home,{recursive:true,force:true});
 });
 return {home,run,env};
}
async function filesUnder(path){let files=[];for(const entry of await readdir(path,{withFileTypes:true})){const child=join(path,entry.name);if(entry.isDirectory())files.push(...await filesUnder(child));else if(entry.isFile())files.push(child);}return files;}
async function success(run,q){const result=await run(q);assert.equal(result.ok,true,result.message);return result.result;}

test('local login survives independent commands without a remote server or secret persistence',async t=>{
 const {home,run}=await fixture(t);
 assert.deepEqual(await success(run,{op:'accounts'}),{current:null,accounts:[]});
 const first=await success(run,{op:'login',username:'alice@team',password});
 assert.equal(first.health.authenticated,true);assert.equal(first.health.identity.username,'alice@team');
 assert.deepEqual(await success(run,{op:'instances'}),[{uuid:'instance-alice@team',name:'belongs-to-alice@team',status:'running'}]);
 const stored=(await Promise.all((await filesUnder(home)).map(f=>readFile(f,'utf8')))).join('\n');
 for(const secret of [password,'fixture-token-secret-'])assert.ok(!stored.includes(secret));
 const pidFile=(await filesUnder(home)).find(path=>path.endsWith('/helper.pid'));
 const pid=(await readFile(pidFile,'utf8')).trim();
 const {stdout:command}=await promisify(execFile)('ps',['-p',pid,'-o','command=']);
 assert.ok(command.includes('local-session-daemon.mjs'));
 for(const secret of [password,'fixture-token-secret-'])assert.ok(!command.includes(secret));
 assert.ok(!JSON.stringify(first).includes(password));
 assert.equal((await stat(home)).mode&0o777,0o700);assert.equal((await stat(first.socket)).mode&0o777,0o600);
 assert.equal((await stat(join(first.socket,'..'))).mode&0o777,0o700);
});

test('local accounts stay isolated and switching or logging out does not expose another session',async t=>{
 const {run}=await fixture(t);
 await success(run,{op:'login',username:'alice@team',password});
 await success(run,{op:'login',username:'bob@team',password});
 assert.equal((await success(run,{op:'instances'}))[0].name,'belongs-to-bob@team');
 await success(run,{op:'select',username:'alice@team'});
 assert.equal((await success(run,{op:'instances'}))[0].name,'belongs-to-alice@team');
 assert.deepEqual(await success(run,{op:'accounts'}),{current:'alice@team',accounts:[{username:'alice@team'},{username:'bob@team'}]});
 await success(run,{op:'logout',username:'alice@team'});
 assert.equal((await success(run,{op:'doctor',username:'alice@team'})).authenticated,false);
 assert.equal((await success(run,{op:'doctor',username:'bob@team'})).authenticated,true);
 assert.equal((await run({op:'instances',username:'alice@team'})).code,'LOGIN_REQUIRED');
});

test('idle helpers exit, stale sockets recover, and recovery requires a new login',async t=>{
 const {home,run}=await fixture(t,{idleMs:200});
 const first=await success(run,{op:'login',username:'alice@team',password});
 await new Promise(resolve=>setTimeout(resolve,650));
 assert.equal((await run({op:'doctor',username:'alice@team',start:false})).code,'LOCAL_SESSION_CLOSED');
 await writeFile(first.socket,'stale socket fixture',{mode:0o600});
 assert.equal((await success(run,{op:'logout',username:'alice@team'})).loggedOut,true);
 const health=await success(run,{op:'doctor',username:'alice@team'});assert.equal(health.authenticated,false);
 assert.equal((await run({op:'instances',username:'alice@team'})).code,'LOGIN_REQUIRED');
 assert.equal((await success(run,{op:'login',username:'alice@team',password})).health.authenticated,true);
 assert.ok((await filesUnder(home)).every(path=>!path.includes(password)));
});

test('local configuration does not accept remote test origins or start without an account',async t=>{
 const {home}=await fixture(t);
 await assert.rejects(()=>loaded.connectLocal({home}),{code:'LOGIN_REQUIRED'});
 const previous=process.env.AUTODL_WEB_ORIGIN;process.env.AUTODL_WEB_ORIGIN='http://example.invalid';
 try{await assert.rejects(()=>loaded.connectLocal({home,username:'alice@team'}),{code:'INVALID_ORIGIN'});}
 finally{if(previous===undefined)delete process.env.AUTODL_WEB_ORIGIN;else process.env.AUTODL_WEB_ORIGIN=previous;}
});

test('an active provider request is allowed to finish before the local idle timeout begins',async t=>{
 const {run}=await fixture(t,{idleMs:200,queryDelayMs:450});
 await success(run,{op:'login',username:'alice@team',password});
 assert.equal((await success(run,{op:'instances',username:'alice@team'}))[0].name,'belongs-to-alice@team');
 assert.equal((await success(run,{op:'doctor',username:'alice@team',start:false})).authenticated,true);
});

test('an invalid response from a live helper is reported instead of replacing its listening socket',async t=>{
 const {run}=await fixture(t);
 const first=await success(run,{op:'login',username:'alice@team',password});
 await success(run,{op:'logout',username:'alice@team'});
 const socketServer=createSocketServer({allowHalfOpen:true},conn=>conn.once('data',()=>conn.end('invalid-rpc-response\n')));
 socketServer.listen(first.socket);await once(socketServer,'listening');t.after(()=>new Promise(resolve=>socketServer.close(resolve)));
 assert.equal((await run({op:'doctor',username:'alice@team'})).code,'NETWORK');
});

test('simultaneous first commands reuse one local helper instead of replacing each other\'s socket',async t=>{
 const {home,run}=await fixture(t);
 const results=await Promise.all(Array.from({length:4},()=>success(run,{op:'doctor',username:'alice@team'})));
 assert.ok(results.every(result=>result.authenticated===false));
 const pidFile=(await filesUnder(home)).find(path=>path.endsWith('/helper.pid'));
 const firstPid=await readFile(pidFile,'utf8');
 await success(run,{op:'login',username:'alice@team',password});
 assert.equal(await readFile(pidFile,'utf8'),firstPid);
 assert.equal((await success(run,{op:'instances'}))[0].name,'belongs-to-alice@team');
});

test('logout acknowledges the requesting process before closing its account helper',async t=>{
 const {home,run}=await fixture(t);
 for(let attempt=0;attempt<3;attempt++){
  await success(run,{op:'login',username:'alice@team',password});
  const result=await loaded.logoutLocal({home,username:'alice@team'});
  assert.equal(result.loggedOut,true);
  assert.equal((await run({op:'doctor',username:'alice@team',start:false})).code,'LOCAL_SESSION_CLOSED');
 }
});
