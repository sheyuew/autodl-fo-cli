import {spawn} from 'node:child_process';import {createServer} from 'node:net';
import {unlink,chmod,mkdir,readFile} from 'node:fs/promises';import {PipeCDP} from './lib/cdp.mjs';
import {BrowserDriver} from './lib/browser.mjs';import {Controller} from './lib/controller.mjs';import {Journal} from './lib/journal.mjs';
import {closeBrowser} from './lib/shutdown.mjs';
import {tenantRuntime,AccountBinding} from './lib/tenant.mjs';import {Notifications} from './lib/notifications.mjs';
import {WorkQueue} from './lib/queue.mjs';
import {FoRuntime,RUNNER_URL} from './lib/runtime.mjs';
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
  if(q.op==='login'){
    await driver({activate:false});interactive=true;
    await cdp.call('Page.navigate',{url:'https://www.autodl.com/console/instance/list'},session);
    return dispatch({op:'viewer'});
  }
  if(q.op==='activate'){
    const d=await driver({activate:false});await binding.check(await d.diagnose());
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
