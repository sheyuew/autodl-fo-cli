import {spawn} from 'node:child_process';import {createServer} from 'node:net';
import {unlink,chmod,mkdir,readFile} from 'node:fs/promises';import {PipeCDP} from './lib/cdp.mjs';
import {BrowserDriver} from './lib/browser.mjs';import {Controller} from './lib/controller.mjs';import {Journal} from './lib/journal.mjs';
import {closeBrowser} from './lib/shutdown.mjs';
import {tenantRuntime,AccountBinding} from './lib/tenant.mjs';import {Notifications} from './lib/notifications.mjs';
import {WorkQueue} from './lib/queue.mjs';
import {FoRuntime,RUNNER_URL} from './lib/runtime.mjs';
import {submitLogin} from './lib/login.mjs';import {readJSON,writeJSON} from './lib/storage.mjs';
process.umask(0o077);
const tenant=tenantRuntime(process.env.FO_TENANT_CONFIG?JSON.parse(await readFile(process.env.FO_TENANT_CONFIG,'utf8')):null);
const {state,socket}=tenant,binding=new AccountBinding(state),notifications=new Notifications(state,tenant.id);
const chrome=spawn('/opt/fo-autodl/browser/chrome-linux64/chrome',[
  '--remote-debugging-pipe',`--user-data-dir=${state}/profile`,
  ...(tenant.id!=='owner'?['--disable-gpu']:[]),
  '--no-first-run','--no-default-browser-check','--start-maximized','--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows','--disable-renderer-backgrounding','--disable-dev-shm-usage',
  tenant.id==='owner'?'https://www.autodl.com/console/instance/list':'about:blank'],{stdio:['ignore','inherit','inherit','pipe','pipe']});
const cdp=new PipeCDP(chrome.stdio[3],chrome.stdio[4],60000);
const runtime=tenant.id==='owner'?null:new FoRuntime(cdp,await readFile('/opt/fo-autodl/www/autodl-helper.user.js','utf8'),state+'/userscript-state.json');
let session,targetId,interactive=false;const queue=new WorkQueue();
const journal=new Journal(tenant.plans);
async function driver({activate=true}={}){
  const {targetInfos}=await cdp.call('Target.getTargets');
  const pages=targetInfos.filter(t=>t.type==='page'&&/^https:\/\/(www\.)?autodl\.com\//.test(t.url));
  const target=pages.find(t=>t.targetId===targetId)||pages.find(t=>t.url===RUNNER_URL)||pages.find(t=>t.url.includes('/console/'))||pages[0]||(runtime?targetInfos.find(t=>t.type==='page'&&t.url==='about:blank'):null);
  if(!target)throw new Error('服务器未打开 AutoDL 页面，请通过远程窗口登录');
  if(targetId!==target.targetId){const attached=await cdp.call('Target.attachToTarget',{targetId:target.targetId,flatten:true});session=attached.sessionId;targetId=target.targetId;}
  const d=new BrowserDriver(cdp,session,runtime?()=>runtime.flush():undefined);
  if(runtime){
    await runtime.install(session);
    if(activate&&!interactive){
      const health=await d.diagnose();
      if(target.url==='about:blank'||(target.url===RUNNER_URL&&!health.fo))await runtime.activate(session);
      else if(health.authenticated&&!health.fo&&health.readyState==='complete'){await binding.check(health);await runtime.activate(session);}
    }
  }
  return d;
}
async function dispatch(q){
  if(!q||typeof q!=='object'||'tenant' in q||'socket' in q||'account' in q)throw new Error('不能通过请求切换账号');
  if(q.op==='notifications')return notifications.list(q.after??0);
  if(q.op==='viewer')return {port:tenant.webPort,password:(await readFile(state+'/vnc-secret','utf8')).trim(),tenant:tenant.id};
  if(q.op==='login-password'){
    const username=q.username?.trim(),password=q.password;
    if(typeof username!=='string'||!username||username.length>200||typeof password!=='string'||!password||password.length>512)throw new Error('请输入有效的 AutoDL 账号和密码');
    const bound=await readJSON(state+'/account-binding.json',null),saved=await readJSON(state+'/login-identity.json',null);
    if(bound&&saved&&saved.username!==username)throw new Error('该环境已绑定另一个 AutoDL 账号，请切换已保存账号或用新邀请码添加账号');
    const d=await driver({activate:false}),health=await d.diagnose();
    if(bound&&!saved){
      const user=await cdp.evaluate(session,"JSON.parse(localStorage.getItem('user')||'{}')");
      if(![user.sub_name,user.username,user.user_name,user.phone].includes(username))throw new Error('该环境已有绑定账号，请使用原登录名；其他账号需新邀请码');
    }
    if(health.authenticated&&bound&&(!saved||saved.username===username)){await binding.check(health);await writeJSON(state+'/login-identity.json',{username});if(runtime&&!health.fo)await runtime.activate(session);interactive=false;return {state:'authenticated',account:health.account};}
    interactive=true;
    await cdp.call('Page.navigate',{url:username.includes('@')?'https://www.autodl.com/subAccountLogin':'https://www.autodl.com/login'},session);
    let result;try{result=await submitLogin(cdp,session,{username,password});}catch{throw new Error('自动登录未完成，请检查网络或使用 fo login-browser');}finally{q.password=undefined;}
    if(result.state==='authenticated'){
      await binding.check(await d.diagnose());await writeJSON(state+'/login-identity.json',{username});
      if(runtime)await runtime.activate(session);interactive=false;
    }
    return result;
  }
  if(q.op==='login'){
    await driver({activate:false});interactive=true;
    await cdp.call('Page.navigate',{url:'https://www.autodl.com/console/instance/list'},session);
    return dispatch({op:'viewer'});
  }
  if(q.op==='activate'){
    const d=await driver({activate:false});
    if(q.username){const user=await cdp.evaluate(session,"JSON.parse(localStorage.getItem('user')||'{}')");if(![user.sub_name,user.username,user.user_name,user.phone].includes(q.username))throw new Error('浏览器登录账号与终端输入不符，请核对后重试');}
    await binding.check(await d.diagnose());
    if(q.username)await writeJSON(state+'/login-identity.json',{username:q.username});
    if(runtime)await runtime.activate(session);interactive=false;
    return {tenant:tenant.id,account:await d.account(),fo:true};
  }
  const d=await driver(),controller=new Controller(d,journal);
  const health=await d.diagnose();
  await runtime?.flush();
  if(q.op!=='doctor'||health.authenticated)await binding.check(health);
  switch(q.op){
    case 'doctor':return {tenant:tenant.id,transport:'SSH + private Unix socket + Chrome pipe',...health,...(health.fo&&health.authenticated?await d.status():{})};
    case 'status':return d.status();
    case 'catalog':return d.catalog(q.query,q.args||{});
    case 'prepare':return controller.prepare(q.spec);
    case 'start':await notifications.observe(await d.status());return controller.start(q.id,q.confirmation);
    case 'result':return controller.result(q.id);
    default:throw new Error('不支持的命令');
  }
}
await mkdir(state+'/cli-plans',{recursive:true,mode:0o700});
await unlink(socket).catch(e=>{if(e.code!=='ENOENT')throw e;});
const server=createServer(conn=>{
  conn.setEncoding('utf8');let data='',done=false;
  conn.on('data',chunk=>{
    if(done)return;data+=chunk;if(Buffer.byteLength(data)>128*1024){done=true;conn.end(JSON.stringify({ok:false,error:'请求过大'})+'\n');return;}
    if(!data.includes('\n'))return;done=true;
    const handle=async()=>{
      try{const result=await dispatch(JSON.parse(data.slice(0,data.indexOf('\n'))));conn.end(JSON.stringify({ok:true,result})+'\n');}
      catch(e){conn.end(JSON.stringify({ok:false,error:e.message})+'\n');}
    };
    let q;try{q=JSON.parse(data.slice(0,data.indexOf('\n')));}catch{void handle();return;}
    if(['viewer','notifications'].includes(q?.op))void handle();else void queue.run(handle);
  });
  conn.on('error',()=>{});
});
const timer=setInterval(()=>{
  queue.sample(async()=>{
    try{const d=await driver();await runtime?.flush();await binding.check(await d.diagnose());await notifications.observe(await d.status());}
    catch(e){await notifications.failure(e.message);}
  })?.catch(e=>console.error('Notification observer:',e.message));
},15000);
server.listen(socket,async()=>{await chmod(socket,0o600);console.log('Fo CLI gateway ready on private Unix socket');});
chrome.on('error',e=>{console.error(e.message);process.exit(1);});
chrome.on('exit',(code)=>{server.close();void (runtime?.flush()||Promise.resolve()).catch(e=>console.error(e.message)).finally(()=>process.exit(stopping?0:code||1));});
let stopping=false;
for(const sig of ['SIGTERM','SIGINT'])process.on(sig,()=>{
  if(stopping)return;stopping=true;clearInterval(timer);server.close();void closeBrowser(cdp,chrome);
});
