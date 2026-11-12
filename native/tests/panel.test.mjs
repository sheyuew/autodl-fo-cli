import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {createHash} from 'node:crypto';

const loaded=await import('../panel-client.mjs').catch(e=>{if(e.code==='ERR_MODULE_NOT_FOUND')return {};throw e;});
const instance={uuid:'instance-a',name:'fixture-instance',status:'running',has_auto_panel:true,jupyter_port:0,jupyter_domain:'fixture.seetacloud.com',jupyter_token:'outer-access-secret'};
async function fixture(t,handler){
  const server=createServer(async(q,r)=>{let body='';for await(const part of q)body+=part;await handler(q,r,body?JSON.parse(body):undefined);});
  server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{server.closeAllConnections();server.close();});
  return {...instance,jupyter_port:server.address().port,proxy_host:'127.0.0.1'};
}
function client(row){assert.ok(loaded.PanelClient,'PanelClient has not been implemented');return new loaded.PanelClient({instance:row});}
function reply(r,data,code='success'){r.setHeader('Content-Type','application/json');r.end(JSON.stringify({code,data}));}

test('does not contact a stopped instance or send access tokens to an unrelated host',()=>{
  for(const row of [{...instance,status:'shutdown'},{...instance,jupyter_domain:'seetacloud.com.attacker.invalid'},{...instance,jupyter_domain:'fixture.seetacloud.com/?token=oops'}]){
    assert.throws(()=>client(row),e=>['PANEL_UNAVAILABLE','INVALID_ORIGIN'].includes(e.code));
  }
});

test('workdir and local directory use only the instance token and encode paths as query values',async t=>{
  const seen=[];const row=await fixture(t,(q,r)=>{
    seen.push(q.url);assert.equal(q.headers.autodlautopaneltoken,'outer-access-secret');assert.equal(q.headers.authorization,undefined);
    const url=new URL(q.url,'http://localhost');
    if(url.pathname.endsWith('/workdir'))reply(r,'/root/autodl-tmp');
    else{assert.equal(url.pathname,'/autopanel/v1/file');assert.equal(url.searchParams.get('abs_path'),'/root/a & b/');reply(r,[{filename:'one.txt',is_dir:false}]);}
  });
  const c=client(row);assert.equal(await c.workdir(),'/root/autodl-tmp');assert.deepEqual(await c.localFiles('/root/a & b'),[{filename:'one.txt',is_dir:false}]);
  assert.equal(seen.length,2);assert.ok(seen.every(x=>!x.includes('secret')));
});

test('panel sign-in uses its independent digest and keeps separate instance sessions',async t=>{
  const row=await fixture(t,(q,r,body)=>{
    assert.equal(q.headers.autodlautopaneltoken,'outer-access-secret');
    if(q.url.endsWith('/sign_in')){
      assert.equal(q.method,'POST');assert.equal(q.headers.authorization,undefined);
      assert.deepEqual(body,{password:createHash('sha1').update('autodlfixture-passwordAutoDL').digest('hex')});reply(r,'panel-session-secret');
    }else{assert.equal(q.url,'/autopanel/v1/netdisk/list');assert.equal(q.headers.authorization,'panel-session-secret');reply(r,null);}
  });
  const a=client(row),b=client({...row,uuid:'instance-b'});
  await a.signIn('fixture-password');assert.deepEqual(await a.accounts(),[]);
  await assert.rejects(b.accounts(),{code:'PANEL_LOGIN_REQUIRED'});
  assert.ok(!JSON.stringify(a).includes('secret'));
});

test('nested authentication failures never become a token and do not register or retry',async t=>{
  let calls=0;const row=await fixture(t,(q,r)=>{calls++;assert.equal(q.url,'/autopanel/v1/sign_in');reply(r,{code:'AuthFailed',msg:'do not expose provider detail'});});
  const c=client(row);await assert.rejects(c.signIn('wrong'),{code:'PANEL_LOGIN_REQUIRED'});await assert.rejects(c.accounts(),{code:'PANEL_LOGIN_REQUIRED'});assert.equal(calls,1);
});

test('uninitialized panels and invalid outer access tokens have distinct errors',async t=>{
  let code='NotInit';const row=await fixture(t,(_q,r)=>reply(r,null,code));const c=client(row);
  await assert.rejects(c.signIn('fixture'),{code:'PANEL_NOT_INITIALIZED'});code='AutoPanelAuthFailed';await assert.rejects(c.workdir(),{code:'PANEL_ACCESS_DENIED'});
});

test('cloud directories encode provider identifiers and collect every marker page',async t=>{
  const pages=[];const row=await fixture(t,(q,r)=>{
    const u=new URL(q.url,'http://localhost');if(u.pathname.endsWith('/sign_in'))return reply(r,'session');
    assert.equal(u.pathname,'/autopanel/v1/netdisk/file');assert.equal(u.searchParams.get('fs_id'),'disk & one');assert.equal(u.searchParams.get('abs_path'),'/folder & one/');
    pages.push(u.searchParams.get('marker'));reply(r,{list:{List:[{filename:pages.length===1?'a':'b'}]},next_marker:pages.length===1?'next & page':''});
  });
  const c=client(row);await c.signIn('fixture');assert.deepEqual(await c.cloudFiles({account:{fs_id:'disk & one',type:'AutoDL_BaiduNetDisk'},path:'/folder & one'}),[{filename:'a'},{filename:'b'}]);assert.deepEqual(pages,['','next & page']);
});

test('Quark and Ali roots use their provider file identifiers without invoking path lookup mutations',async t=>{
  const seen=[];const row=await fixture(t,(q,r)=>{
    const u=new URL(q.url,'http://localhost');if(u.pathname.endsWith('/sign_in'))return reply(r,'session');
    assert.equal(u.pathname,'/autopanel/v1/netdisk/file');seen.push(Object.fromEntries(u.searchParams));reply(r,{list:{List:[]},next_marker:''});
  });
  const c=client(row);await c.signIn('fixture');
  await c.cloudFiles({account:{fs_id:'quark',type:'AutoDL_Quark'}});
  await c.cloudFiles({account:{fs_id:'ali',type:'AutoDL_AliPan',user_info:{resource_drive_id:'resource',default_drive_id:'backup'}},source:'backup'});
  assert.deepEqual(seen,[{fs_id:'quark',marker:'',file_id:'0'},{fs_id:'ali',marker:'',driver_id:'backup',file_id:'/'}]);
});

test('transfer queues validate the response and an expired panel login does not affect outer access',async t=>{
  let expired=false;const row=await fixture(t,(q,r)=>{
    if(q.url.endsWith('/sign_in'))return reply(r,'session');
    if(q.url.endsWith('/workdir'))return reply(r,'/root/autodl-tmp');
    if(expired)return reply(r,null,'AuthFailed');
    reply(r,{task_doing:[{file_name:'a',progress:{current:1,total:2,rate:3}}],task_success:2,task_total:3});
  });
  const c=client(row);await c.signIn('fixture');assert.equal((await c.activeTasks()).task_doing.length,1);
  expired=true;await assert.rejects(c.activeTasks(),{code:'PANEL_LOGIN_REQUIRED'});assert.equal(await c.workdir(),'/root/autodl-tmp');
});

test('mutating endpoints, including GET task clear, are rejected before a request',async t=>{
  let calls=0;const row=await fixture(t,(_q,r)=>{calls++;reply(r,null);});const c=client(row);
  for(const operation of ['clearTask','/netdisk/task/clear','downloadFile','uploadFile','resetDisk','exportAuth','sign_up','constructor'])await assert.rejects(c.read(operation),{code:'READ_ONLY'});
  assert.equal(calls,0);
});

test('does not follow redirects with either token or confuse malformed and temporary responses',async t=>{
  let mode='redirect',leaked=0;
  const destination=await fixture(t,(_q,r)=>{leaked++;reply(r,'unexpected');});
  const row=await fixture(t,(_q,r)=>{
    if(mode==='redirect'){r.writeHead(302,{Location:`http://127.0.0.1:${destination.jupyter_port}/`});r.end();}
    else if(mode==='temporary'){r.statusCode=503;r.end('temporary');}
    else if(mode==='shape')reply(r,{unexpected:true});
    else reply(r,'/work');
  });const c=client(row);
  await assert.rejects(c.workdir(),{code:'NETWORK'});assert.equal(leaked,0);
  mode='temporary';await assert.rejects(c.workdir(),e=>e.code==='API_ERROR'&&e.retryable);
  mode='shape';await assert.rejects(c.workdir(),{code:'SCHEMA_CHANGED'});
  mode='ok';assert.equal(await c.workdir(),'/work');
});
