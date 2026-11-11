import test from 'node:test';import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join} from 'node:path';import {createServer} from 'node:http';
import {once} from 'node:events';import {PipeCDP} from '../lib/cdp.mjs';

function providerFixture(identity='fixture'){
  const G=1024**3;
  const rows=[{uuid:'source-eight',name:'eight',machine_id:'m8',req_gpu_amount:8,snapshot_gpu_alias_name:'A',region_sign:'a',status:'shutdown',start_mode:'gpu',expand_data_disk_size:0},
    {uuid:'source-one',name:'one',machine_id:'m1',req_gpu_amount:1,snapshot_gpu_alias_name:'A',region_sign:'a',status:'shutdown',start_mode:'gpu',expand_data_disk_size:0}];
  globalThis.fixtureStore=new Map();globalThis.GM_getValue=(k,d)=>structuredClone(fixtureStore.get(k)||d);
  globalThis.GM_setValue=(k,v)=>fixtureStore.set(k,structuredClone(v));globalThis.GM_addValueChangeListener=()=>{};
  globalThis.GM_notification=()=>{};globalThis.GM_xmlhttpRequest=()=>{throw new Error('fixture disables notifications');};
  localStorage.setItem('user',JSON.stringify({uuid:identity,sub_name:'test'}));localStorage.setItem('token','not-a-real-token');
  globalThis.fetch=async(path,options={})=>{
    path=String(path).replace('/sub_user/','/');let data;
    if(path==='/api/v1/instance')data={list:rows,result_total:2,page_size:90};
    else if(path==='/api/v1/region/list')data=[{visible:'all',used_for:'all',data_center:'r1',region_name:'一区',region_sign:'a'}];
    else if(path==='/api/v1/machine/gpu_type')data=['A','B'].map(gpu_name=>({gpu_name,chip_corp:'nvidia',cpu_arch:'x86'}));
    else if(path==='/api/v1/machine/region/gpu_type')data=[{A:0,B:0}];
    else if(path==='/api/v1/user/machine/list'){
      const body=JSON.parse(options.body);data={list:body.gpu_idle_num===0?[{gpu_name:'A',region_sign:'a',driver_version:'550.1'},{gpu_name:'B',region_sign:'a',driver_version:'550.1'}]:[],result_total:body.gpu_idle_num===0?2:0,page_size:90};
    }else if(path==='/api/v1/image/private/get')data=[{image_uuid:'i1',name:'private image',chip_corp:'nvidia',cpu_arch:'x86',cuda_v:'12.1'}];
    else if(path==='/api/v1/image/all')data=[{label_name:{uuid:'base1',v:'12.1',chip_corp:'nvidia',cpu_arch:'x86'}}];
    else if(path.startsWith('/api/v1/instance/snapshot'))data={machine_info_snapshot:{gpu_name:'A',max_instance_disk_size:50*G},image:{image_type:'public',image_name:'base1',chip_corp:'nvidia',cpu_arch:'x86',cuda_version:'12.1'},expand_data_disk_size:0};
    else if(path==='/api/v1/machine/detail')data={gpu_idle_num:0,on_line:1};
    else throw new Error('Unexpected provider call: '+path);
    return {ok:true,status:200,json:async()=>({code:'Success',data})};
  };
}
test('real upstream Fo forms: three modes, confirmation, duplicate protection and task preservation', {timeout:120000},async t=>{
  const dir=await mkdtemp(join(tmpdir(),'fo-browser-'));
  const child=spawn(process.env.FO_TEST_CHROME||'/opt/fo-autodl/browser/chrome-linux64/chrome',[
    '--headless=new','--remote-debugging-pipe',`--user-data-dir=${dir}/profile`,'--no-first-run','--disable-dev-shm-usage','about:blank'],{stdio:['ignore','ignore','pipe','pipe','pipe']});
  let err='';child.stderr.on('data',b=>{err+=b.toString();});
  const cdp=new PipeCDP(child.stdio[3],child.stdio[4],45000);
  const web=createServer((q,r)=>{r.setHeader('Content-Type','text/html');r.end('<!doctype html><html><body>Isolated Fo test fixture</body></html>');});
  web.listen(0,'127.0.0.1');await once(web,'listening');
  t.after(async()=>{child.kill('SIGTERM');web.close();await once(child,'exit').catch(()=>{});await rm(dir,{recursive:true,force:true});});
  const {targetInfos}=await cdp.call('Target.getTargets');const target=targetInfos.find(x=>x.type==='page');assert.ok(target,err);
  const {sessionId}=await cdp.call('Target.attachToTarget',{targetId:target.targetId,flatten:true});
  await cdp.call('Page.navigate',{url:`http://127.0.0.1:${web.address().port}/`},sessionId);
  await new Promise(r=>setTimeout(r,300));
  await cdp.evaluate(sessionId,`(${providerFixture.toString()})()`);
  const source=await readFile(process.env.FO_UPSTREAM||'/opt/fo-autodl/www/autodl-helper.user.js','utf8');
  await cdp.evaluate(sessionId,source);
  const {BrowserDriver}=await import('../lib/browser.mjs');
  const {Controller}=await import('../lib/controller.mjs');const {Journal}=await import('../lib/journal.mjs');
  const driver=new BrowserDriver(cdp,sessionId),controller=new Controller(driver,new Journal(join(dir,'plans')));
  const common={gpus:['B','A'],gpuCount:4,minMemoryGb:30,minExpandGb:0,expandGb:0,driver:{mode:'exact',value:'550.1'}};
  const clone=await controller.prepare({mode:'clone',instances:['source-eight'],...common});
  await driver.stage(clone);assert.equal((await driver.status()).tasks.length,0);
  assert.equal((await controller.start(clone.id,clone.confirmation)).state,'accepted');
  await controller.start(clone.id,clone.confirmation);
  assert.equal((await driver.status()).tasks.length,1);
  const original=await controller.prepare({mode:'existing',instances:['source-one']});
  assert.equal((await controller.start(original.id,original.confirmation)).state,'accepted');
  const fresh=await controller.prepare({mode:'new',...common,regions:['r1'],imageType:'private',image:'i1',name:'new training',expandGb:100});
  await driver.stage(fresh);assert.equal((await driver.status()).tasks.length,2);
  assert.equal((await controller.start(fresh.id,fresh.confirmation)).state,'accepted');
  const state=await cdp.evaluate(sessionId,"fixtureStore.get('autodl-helper-v1')");
  assert.equal(state.tasks.length,3);
  assert.equal(state.tasks[0].sourceUuid,'source-eight');assert.equal(state.tasks[0].targetFilters.gpuCount,4);
  assert.deepEqual(state.tasks[0].targetFilters.gpus,['B','A']);assert.equal(state.tasks[0].targetFilters.minMemoryGb,30);
  assert.equal(state.tasks[1].instanceUuid,'source-one');
  assert.equal(state.tasks[2].config.image.uuid,'i1');assert.equal(state.tasks[2].config.expandGb,100);
  assert.equal(state.tasks[2].config.driver.value,'550.1');assert.match(state.tasks[2].name,/CLI-/);
  // Exercise the production lightweight runtime with real origin-local storage.
  // Provider responses alone are replaced; no real AutoDL credentials are used.
  const {FoRuntime}=await import('../lib/runtime.mjs');
  async function member(identity){
    const runtime=new FoRuntime(cdp,source,join(dir,identity,'userscript-state.json'));
    const {browserContextId}=await cdp.call('Target.createBrowserContext');
    const {targetId}=await cdp.call('Target.createTarget',{url:'about:blank',browserContextId});
    const {sessionId:s}=await cdp.call('Target.attachToTarget',{targetId,flatten:true});
    await cdp.call('Runtime.enable',{},s);
    cdp.on('Runtime.exceptionThrown',e=>{if(e.sessionId===s)console.error('Runtime exception:',e.params.exceptionDetails.exception?.description||e.params.exceptionDetails.text);});
    await cdp.call('Page.addScriptToEvaluateOnNewDocument',{source:`(${providerFixture.toString()})(${JSON.stringify(identity)})`},s);
    try{await runtime.activate(s);}catch(e){console.error('Runtime page:',await cdp.evaluate(s,"({url:location.href,ready:document.readyState,gm:typeof GM_getValue,body:document.body?.textContent.slice(0,200)})"));throw e;}
    return {runtime,sessionId:s,driver:new BrowserDriver(cdp,s,()=>runtime.flush())};
  }
  const alice=await member('alice'),aliceController=new Controller(alice.driver,new Journal(join(dir,'alice-plans')));
  const a=await aliceController.prepare({mode:'clone',instances:['source-eight'],...common});
  assert.equal((await aliceController.start(a.id,a.confirmation)).state,'accepted');
  await cdp.evaluate(alice.sessionId,'localStorage.clear()');
  await alice.runtime.activate(alice.sessionId);
  assert.equal((await alice.driver.status()).tasks.length,1,'task survives a new document using persistent storage');
  const bob=await member('bob');
  assert.equal((await bob.driver.status()).account,'bob:test');assert.equal((await bob.driver.status()).tasks.length,0);
  assert.equal((await alice.driver.status()).account,'alice:test');assert.equal((await alice.driver.status()).tasks.length,1);
  assert.equal((await driver.status()).tasks.length,3,'existing browser remains untouched');
});
