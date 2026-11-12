import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
const loaded=await import('../web-client.mjs').catch(e=>{if(e.code==='ERR_MODULE_NOT_FOUND')return {};throw e;});
const session={token:'fixture-a',user:{id:'123',sub_name:'alice@team'},appVersion:'1.2.3'};
async function server(t,handler){const s=createServer(handler);s.listen(0,'127.0.0.1');await once(s,'listening');t.after(()=>{s.closeAllConnections();s.close();});return `http://127.0.0.1:${s.address().port}`;}
const ok=(r,data)=>{r.setHeader('Content-Type','application/json');r.end(JSON.stringify({code:'Success',data}));};
function client(options){assert.ok(loaded.WebClient,'WebClient has not been implemented');return new loaded.WebClient(options);}

test('subaccount identity and all instance pages are read through its own authenticated endpoint',async t=>{
  let calls=0;
  const baseUrl=await server(t,async(q,r)=>{let body='';for await(const part of q)body+=part;const b=JSON.parse(body);
    assert.equal(q.url,'/api/v1/sub_user/instance');assert.equal(q.method,'POST');assert.equal(q.headers.authorization,'fixture-a');assert.equal(q.headers.appversion,'1.2.3');
    calls++;ok(r,{list:b.page_index===1?[{uuid:'one'}]:[{uuid:'two'}],result_total:2,page_size:1});});
  const c=client({session,expectedUsername:'alice@team',baseUrl});
  assert.equal(c.identity.username,'alice@team');
  assert.deepEqual(await c.instances(),[{uuid:'one'},{uuid:'two'}]);assert.equal(calls,2);
});

test('rejects a session belonging to a different account before sending any request',()=>{
  assert.throws(()=>client({session,expectedUsername:'bob@team'}),{code:'ACCOUNT_MISMATCH'});
});

test('rejects paid or arbitrary operations before they reach the network',async t=>{
  let requests=0;const baseUrl=await server(t,(_q,r)=>{requests++;ok(r,[]);});const c=client({session,baseUrl});
  await assert.rejects(c.read('powerOn'),{code:'READ_ONLY'});assert.equal(requests,0);
});

test('marks expired sessions unusable and never silently retries or switches accounts',async t=>{
  let calls=0;const baseUrl=await server(t,(_q,r)=>{calls++;r.end(JSON.stringify({code:'AuthorizeFailed',msg:'expired'}));});const c=client({session,baseUrl});
  await assert.rejects(c.regions(),{code:'LOGIN_REQUIRED'});await assert.rejects(c.instances(),{code:'LOGIN_REQUIRED'});assert.equal(calls,1);
});

test('separate clients keep authorization independent',async t=>{
  const baseUrl=await server(t,(q,r)=>ok(r,[{owner:q.headers.authorization}]));
  const a=client({session,baseUrl}),b=client({session:{...session,token:'fixture-b',user:{id:'456',sub_name:'bob@team'}},baseUrl});
  const [x,y]=await Promise.all([a.regions(),b.regions()]);assert.deepEqual(x,[{owner:'fixture-a'}]);assert.deepEqual(y,[{owner:'fixture-b'}]);
});

test('does not report a malformed instance response as an empty account',async t=>{
  const baseUrl=await server(t,(_q,r)=>ok(r,{unexpected:[]}));const c=client({session,baseUrl});await assert.rejects(c.instances(),{code:'SCHEMA_CHANGED'});
});

test('an HTTP 401 with a non-JSON body still invalidates the session',async t=>{
  let calls=0;const baseUrl=await server(t,(_q,r)=>{calls++;r.statusCode=401;r.end('Unauthorized');});const c=client({session,baseUrl});
  await assert.rejects(c.regions(),{code:'LOGIN_REQUIRED'});await assert.rejects(c.instances(),{code:'LOGIN_REQUIRED'});assert.equal(calls,1);
});

test('reads a subaccount snapshot using an encoded instance id without moving credentials into the URL',async t=>{
  const baseUrl=await server(t,(q,r)=>{
    const u=new URL(q.url,'http://localhost');assert.equal(u.pathname,'/api/v1/sub_user/instance/snapshot');assert.deepEqual([...u.searchParams],[['instance_uuid','instance & one']]);assert.equal(q.method,'GET');assert.equal(q.headers.authorization,'fixture-a');ok(r,{proxy_host:'fixture.invalid',ssh_port:12345});
  });
  const c=client({session,baseUrl});assert.equal(typeof c.snapshot,'function','Snapshot reading has not been implemented');
  assert.deepEqual(await c.snapshot('instance & one'),{proxy_host:'fixture.invalid',ssh_port:12345});
});
