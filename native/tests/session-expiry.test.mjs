import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createConnection} from 'node:net';
import {once} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {startHttpServer} from '../http-server.mjs';
import {RemoteClient} from '../remote-client.mjs';

async function fixture(t){
 const state=await mkdtemp('/tmp/fo-expiry-'),socket=join(state,'control.sock');
 const requests=[],expired={web:null,panel:null};
 const provider=createServer(async(q,r)=>{
  let raw='';for await(const part of q)raw+=part;const body=raw?JSON.parse(raw):{};requests.push(q.url);let data,code='Success';
  const panel=q.url.startsWith('/autopanel/v1/'),mode=panel?expired.panel:expired.web;
  if(mode&&!(q.url.endsWith('/login')||q.url.endsWith('/passport'))){
   if(mode==='http'){r.statusCode=401;r.end('Unauthorized');return;}
   r.end(JSON.stringify({code:panel?'AuthFailed':'TokenExpired',data:null}));return;
  }
  if(q.url==='/api/v1/sub_user/login')data={ticket:body.sub_name,user:{id:1,sub_name:body.sub_name}};
  else if(q.url==='/api/v1/sub_user/passport')data={token:'fixture-web-session'};
  else if(q.url==='/api/v1/sub_user/instance')data={list:[{uuid:'instance-one',name:'fixture',status:'running',has_auto_panel:true,jupyter_token:'fixture-outer',proxy_host:'127.0.0.1',jupyter_port:provider.address().port}],result_total:1};
  else if(q.url==='/api/v1/sub_user/region/list')data=[];
  else if(q.url==='/autopanel/v1/sign_in'){code='success';data='fixture-panel-session';}
  else if(q.url==='/autopanel/v1/workdir'){code='success';data='/root/autodl-tmp';}
  else {r.statusCode=404;r.end();return;}
  r.end(JSON.stringify({code,data}));
 });
 provider.listen(0,'127.0.0.1');await once(provider,'listening');
 const service=await startHttpServer({state,socket,baseUrl:`http://127.0.0.1:${provider.address().port}`,logger:()=>{}});
 t.after(async()=>{await service.close();provider.closeAllConnections();await new Promise(resolve=>provider.close(resolve));await rm(state,{recursive:true,force:true});});
 const request=q=>new Promise((resolve,reject)=>{
  const conn=createConnection(socket);let data='';conn.on('connect',()=>conn.end(JSON.stringify(q)+'\n'));
  conn.on('data',chunk=>data+=chunk);conn.on('error',reject);conn.on('end',()=>{
   try{const reply=JSON.parse(data);if(!reply.ok)return reject(Object.assign(new Error(reply.error),{code:reply.code}));resolve(reply.result);}catch(error){reject(error);}
  });
 });
 return {client:new RemoteClient({request}),expired,requests};
}

for(const mode of ['http','envelope'])test(`known AutoDL expiry (${mode}) clears doctor authentication and restored identity until a new login`,async t=>{
 const {client,expired,requests}=await fixture(t);
 await client.login('alice@team','fixture-password');assert.equal((await client.restore()).authenticated,true);
 expired.web=mode;
 await assert.rejects(client.instances(),{code:'LOGIN_REQUIRED'});
 const health=await client.restore();assert.equal(health.authenticated,false);assert.equal(health.identity,null);assert.equal(client.identity,undefined);
 const count=requests.length;await assert.rejects(client.regions(),{code:'LOGIN_REQUIRED'});assert.equal(requests.length,count);
 expired.web=null;
 await client.login('alice@team','fixture-password');assert.equal((await client.restore()).authenticated,true);
 assert.equal(client.identity.username,'alice@team');assert.equal((await client.instances()).length,1);
});

for(const mode of ['http','envelope'])test(`AutoPanel expiry (${mode}) preserves the independent AutoDL login and instance access`,async t=>{
 const {client,expired}=await fixture(t);
 await client.login('alice@team','fixture-password');
 const panel=await client.openPanel('instance-one');await panel.signIn('fixture-panel-password');
 expired.panel=mode;
 await assert.rejects(panel.workdir(),{code:mode==='http'?'PANEL_ACCESS_DENIED':'PANEL_LOGIN_REQUIRED'});
 const health=await client.restore();assert.equal(health.authenticated,true);assert.equal(client.identity.username,'alice@team');
 assert.equal((await client.instances()).length,1);
});
