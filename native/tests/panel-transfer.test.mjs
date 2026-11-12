import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {PanelClient} from '../panel-client.mjs';

const account={fs_id:'disk-one',type:'AutoDL_AliPan',user_info:{resource_drive_id:'resource-drive',default_drive_id:'backup-drive'}};
async function fixture(t,handler){
  const requests=[];
  const server=createServer(async(q,r)=>{
    let raw='';for await(const p of q)raw+=p;const body=raw?JSON.parse(raw):undefined;
    if(q.url==='/autopanel/v1/sign_in'){r.end(JSON.stringify({code:'success',data:'inner-token'}));return;}
    requests.push({url:q.url,method:q.method,body});await handler(q,r,body);
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{server.closeAllConnections();server.close();});
  const panel=new PanelClient({instance:{status:'running',has_auto_panel:true,jupyter_token:'outer-token',jupyter_port:server.address().port,proxy_host:'127.0.0.1'}});
  return {panel,requests};
}
function reply(r,data){r.end(JSON.stringify({code:'success',data}));}
function implemented(panel){assert.equal(typeof panel.upload,'function','Explicit upload submission has not been implemented');assert.equal(typeof panel.download,'function','Explicit download submission has not been implemented');}

test('transfers require explicit confirmation and an independent panel login before any submission',async t=>{
  const {panel,requests}=await fixture(t,(_q,r)=>reply(r,null));implemented(panel);
  const upload={account,localPath:'/root/autodl-tmp/source/test.bin'};
  await assert.rejects(panel.upload(upload),{code:'CONFIRMATION_REQUIRED'});
  await assert.rejects(panel.upload({...upload,confirmed:true}),{code:'PANEL_LOGIN_REQUIRED'});
  await panel.signIn('fixture');await assert.rejects(panel.upload({...upload,confirmed:'yes'}),{code:'CONFIRMATION_REQUIRED'});
  assert.equal(requests.length,0);
});

test('upload submits one server file to the chosen cloud directory with both authentication layers',async t=>{
  const {panel,requests}=await fixture(t,(q,r,body)=>{
    assert.equal(q.url,'/autopanel/v1/netdisk/upload');assert.equal(q.method,'POST');assert.equal(q.headers.authorization,'inner-token');assert.equal(q.headers.autodlautopaneltoken,'outer-token');
    assert.deepEqual(body,{dst_path:'/tests/',fsid:'disk-one',src_path:'/root/autodl-tmp/source/test.bin',file_id:'tests-folder-id',is_dir:false,drive_id:'resource-drive'});
    reply(r,{task_id:'upload-task',download_url:'must-not-return'});
  });implemented(panel);await panel.signIn('fixture');
  assert.deepEqual(await panel.upload({account,localPath:'/root/autodl-tmp/source/test.bin',remoteDirectory:'/tests',parentFileId:'tests-folder-id',confirmed:true}),{accepted:true,taskId:'upload-task'});
  assert.equal(requests.length,1);
});

test('download uses the selected cloud file and default instance download directory, without reporting completion on acceptance',async t=>{
  const {panel,requests}=await fixture(t,(q,r,body)=>{
    assert.equal(q.url,'/autopanel/v1/netdisk/download');assert.equal(q.method,'POST');
    assert.deepEqual(body,{dst_path:'',fsid:'disk-one',src_path:'/tests/test.bin',file_id:'cloud-file-id',is_dir:false,download_url:'https://fixture.invalid/private-download',file_size:262144,drive_id:'backup-drive'});
    reply(r,null);
  });implemented(panel);await panel.signIn('fixture');
  const receipt=await panel.download({account,source:'backup',remoteDirectory:'/tests',file:{name:'test.bin',file_id:'cloud-file-id',size:262144,is_dir:false,download_url:'https://fixture.invalid/private-download'},confirmed:true});
  assert.deepEqual(receipt,{accepted:true});assert.equal(requests.length,1);assert.equal(receipt.completed,undefined);
});

test('invalid paths, unsupported storage and directory transfers fail without creating a task',async t=>{
  const {panel,requests}=await fixture(t,(_q,r)=>reply(r,null));implemented(panel);await panel.signIn('fixture');
  for(const localPath of ['relative.bin','/root/folder/','/root/a\0b'])await assert.rejects(panel.upload({account,localPath,confirmed:true}),{code:'PATH_REQUIRED'});
  await assert.rejects(panel.upload({account:{...account,type:'AutoDL_Quark'},localPath:'/root/file.bin',confirmed:true}),{code:'DISK_UNSUPPORTED'});
  await assert.rejects(panel.upload({account,localPath:'/root/file.bin',remoteDirectory:'/folder',confirmed:true}),{code:'PATH_REQUIRED'});
  await assert.rejects(panel.download({account,file:{name:'folder',file_id:'folder',is_dir:true},confirmed:true}),{code:'FILE_REQUIRED'});
  await assert.rejects(panel.download({account,file:{name:'../file',file_id:'file',size:1},confirmed:true}),{code:'FILE_REQUIRED'});
  assert.equal(requests.length,0);
});

test('a disconnected transfer submission is uncertain and is never retried automatically',async t=>{
  const {panel,requests}=await fixture(t,q=>q.socket.destroy());implemented(panel);await panel.signIn('fixture');
  await assert.rejects(panel.upload({account,localPath:'/root/file.bin',confirmed:true}),e=>e.code==='TRANSFER_UNCERTAIN'&&e.retryable===false);
  assert.equal(requests.length,1);
});

test('a transfer service failure or malformed success does not invite a duplicate submission',async t=>{
  let malformed=false;const {panel,requests}=await fixture(t,(_q,r)=>{if(malformed){r.end('{broken');}else{r.statusCode=503;r.end('temporary');}});implemented(panel);await panel.signIn('fixture');
  await assert.rejects(panel.upload({account,localPath:'/root/file.bin',confirmed:true}),{code:'TRANSFER_UNCERTAIN'});
  malformed=true;await assert.rejects(panel.upload({account,localPath:'/root/other.bin',confirmed:true}),{code:'TRANSFER_UNCERTAIN'});
  assert.equal(requests.length,2);
});
