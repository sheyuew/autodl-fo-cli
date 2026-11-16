import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {once} from 'node:events';
import {mkdir,writeFile,readFile,mkdtemp,rm,lstat} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {RemoteClient,sshTransport} from '../remote-client.mjs';
import {localPaths,connectLocal} from '../local-session.mjs';
import {provisionFixture,policy,until} from './provision-service-fixture.mjs';

const moduleUrl=new URL('../local-session.mjs',import.meta.url).href;
const cli=fileURLToPath(new URL('../../cli.mjs',import.meta.url));
const driver=`const m=await import(${JSON.stringify(moduleUrl)});let raw='';for await(const p of process.stdin)raw+=p;const q=JSON.parse(raw);try{let r;if(q.op==='login')r=(await m.loginLocal(q.username,q.password)).result;else if(q.op==='logout')r=await m.logoutLocal({username:q.username});else {const c=await m.connectLocal({username:q.username,start:q.start!==false});r=q.op==='doctor'?c.health:await c.request(q.request);}console.log(JSON.stringify({ok:true,result:r}));}catch(e){console.log(JSON.stringify({ok:false,code:e.code,error:e.message}));}`;
function command(args,{env,input}={}){return new Promise((resolve,reject)=>{const p=spawn(process.execPath,args,{env,stdio:['pipe','pipe','pipe']});let out='',err='';const timer=setTimeout(()=>{p.kill();reject(new Error('command timed out'));},10000);p.on('error',reject);p.stdout.on('data',v=>out+=v);p.stderr.on('data',v=>err+=v);p.on('close',code=>{clearTimeout(timer);try{resolve({exit:code,...JSON.parse(out)});}catch{reject(new Error(out+' '+err));}});p.stdin.end(input);});}
async function taskFixture(t,{idleMs=5000}={}){
 let run;t.after(async()=>{if(run)await run({op:'logout',username:'alice@team'}).catch(()=>{});});
 const f=await provisionFixture(t),home=join(f.directory,'local-home'),bin=join(f.directory,'bin'),notificationLog=join(f.directory,'notifications.log');await mkdir(bin);
 const notifier='#!/bin/sh\nprintf \'%s\\n\' "$@" >> "$FO_NOTIFICATION_TEST_LOG"\n';
 for(const name of ['osascript','notify-send'])await writeFile(join(bin,name),notifier,{mode:0o700});
 const env={...process.env,FO_LOCAL_HOME:home,FO_LOCAL_IDLE_MS:String(idleMs),AUTODL_WEB_ORIGIN:f.baseUrl,PATH:bin+':'+process.env.PATH,FO_NOTIFICATION_TEST_LOG:notificationLog};
 run=q=>command(['--input-type=module','-e',driver],{env,input:JSON.stringify(q)});
 const invoke=args=>command([cli,...args,'--json'],{env});
 const login=()=>run({op:'login',username:'alice@team',password:'fixture-password'});
 const prepare=()=>invoke(['task','prepare','--data',JSON.stringify(policy)]);
 const start=async()=>{assert.equal((await login()).ok,true);const plan=await prepare();assert.equal(plan.ok,true,plan.error);const task=await invoke(['task','start',plan.result.planId,'--confirm','yes']);assert.equal(task.ok,true,task.error);return task.result;};
 return {...f,home,env,run,invoke,login,start,notificationLog};
}

test('an active local acquisition survives closed command processes and idle timeout, then cancellation restores idle exit',async t=>{
 const f=await taskFixture(t,{idleMs:200});f.state.idle=0;const task=await f.start();await new Promise(resolve=>setTimeout(resolve,650));
 const health=await f.run({op:'doctor',username:'alice@team',start:false});assert.equal(health.ok,true,health.error);assert.equal(health.result.authenticated,true);assert.equal(health.result.activeTasks,true);
 const info=await f.invoke(['task','info',task.id]);assert.equal(info.result.state,'waiting');const cancelled=await f.invoke(['task','cancel',task.id,'--confirm','yes']);assert.equal(cancelled.result.state,'cancelled');
 const {socket}=await localPaths('alice@team',{home:f.home});await until(()=>lstat(socket).then(()=>false,error=>{if(error.code==='ENOENT')return true;throw error;}),{timeout:3000});
 assert.equal((await f.run({op:'doctor',username:'alice@team',start:false})).code,'LOCAL_SESSION_CLOSED');
 const notification=await readFile(f.notificationLog,'utf8');assert.ok(notification.includes('已停止本地监控'));assert.ok(!notification.includes('fixture-private-token-'));
});

test('logout stops a background task and a new login reads paused history without resuming paid authorization',async t=>{
 const f=await taskFixture(t);f.state.idle=0;const task=await f.start();assert.equal((await f.run({op:'logout',username:'alice@team'})).ok,true);
 assert.equal((await f.login()).ok,true);const listed=await f.invoke(['task','list']);assert.equal(listed.ok,true,listed.error);assert.equal(listed.result.find(x=>x.id===task.id).state,'paused');
 await new Promise(resolve=>setTimeout(resolve,500));assert.equal(f.seen.filter(x=>x.path.includes('/instance/create/payg')).length,0);
});

test('remote client exposes provisioning and account-scoped acquisition RPC without losing explicit confirmations',async()=>{
 const seen=[],client=new RemoteClient({request:async q=>{seen.push(q);return q;}});
 assert.equal(typeof client.prepareTask,'function');await client.provisionCatalog({gpuCount:1});await client.prepareProvision('create',{machineId:123});await client.executeProvision('p');await client.executeProvision('p',{confirmed:true});await client.prepareTask(policy);await client.startTask('t',{confirmed:true});await client.tasks();await client.taskInfo('one');await client.cancelTask('one');await client.notifications(5);
 assert.deepEqual(seen,[{op:'provision-catalog',args:{gpuCount:1}},{op:'provision-prepare',mode:'create',args:{machineId:123}},{op:'provision-execute',planId:'p',confirmed:false},{op:'provision-execute',planId:'p',confirmed:true},{op:'task-prepare',policy},{op:'task-start',planId:'t',confirmed:true},{op:'task-list'},{op:'task-info',taskId:'one'},{op:'task-cancel',taskId:'one',confirmed:false},{op:'notifications',after:5}]);
});

test('a dropped local acknowledgement for provisioning or task authorization is uncertain and never retryable',async t=>{
 const home=await mkdtemp(join(tmpdir(),'fo-task-ack-')),paths=await localPaths('alice@team',{home});
 const server=createServer({allowHalfOpen:true},c=>c.once('data',raw=>{const q=JSON.parse(raw);c.end(q.op==='doctor'?JSON.stringify({ok:true,result:{backend:'native-http',authenticated:true,identity:{username:'alice@team'}}})+'\n':'incomplete-response\n');}));server.listen(paths.socket);await once(server,'listening');
 t.after(async()=>{await new Promise(resolve=>server.close(resolve));await rm(home,{recursive:true,force:true});});
 const context=await connectLocal({home,username:'alice@team',start:false});
 for(const op of ['provision-execute','task-start','task-cancel'])await assert.rejects(()=>context.request({op,planId:'one',taskId:'one',confirmed:true}),{code:'ACTION_UNCERTAIN',retryable:false});
});

test('a dropped SSH acknowledgement for provisioning or task authorization is uncertain and never retryable',async t=>{
 const home=await mkdtemp(join(tmpdir(),'fo-task-ssh-ack-')),previous=process.env.PATH;
 await writeFile(join(home,'ssh'),'#!/bin/sh\n/bin/cat >/dev/null\nprintf \'incomplete-response\\n\'\n',{mode:0o700});process.env.PATH=home;
 t.after(async()=>{process.env.PATH=previous;await rm(home,{recursive:true,force:true});});
 const request=sshTransport({host:'member@example.test',port:22,identityFile:'fixture-key',protocol:'multi-v1'},home);
 for(const op of ['provision-execute','task-start','task-cancel'])await assert.rejects(()=>request({op,planId:'one',taskId:'one',confirmed:true}),{code:'ACTION_UNCERTAIN',retryable:false});
});
