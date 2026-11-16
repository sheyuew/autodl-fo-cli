import test from 'node:test';import assert from 'node:assert/strict';import {createServer} from 'node:http';import {once} from 'node:events';import {WebClient} from '../web-client.mjs';
const session={token:'network-fixture',user:{id:'fixture',sub_name:'alice@team'},appVersion:'1.2.3'};
async function serve(t,handler){const server=createServer(handler);server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{server.closeAllConnections();server.close();});return `http://127.0.0.1:${server.address().port}`;}
const success=r=>r.end(JSON.stringify({code:'Success',data:[{region_name:'fixture-region'}]}));

test('a disconnected socket fails once and the same session can read again when the network returns',async t=>{
  let calls=0;const baseUrl=await serve(t,(q,r)=>{calls++;if(calls===1)q.socket.destroy();else success(r);});const c=new WebClient({session,baseUrl});
  await assert.rejects(c.regions(),{code:'NETWORK',operation:'/api/v1/region/list'});assert.equal(calls,1);assert.deepEqual(await c.regions(),[{region_name:'fixture-region'}]);assert.equal(calls,2);
});

test('a timeout while reading a response body is a network failure and does not invalidate the session',async t=>{
  let calls=0;const baseUrl=await serve(t,(_q,r)=>{calls++;if(calls===1){r.writeHead(200,{'Content-Type':'application/json'});r.write('{"code":"Success","data":');}else success(r);});const c=new WebClient({session,baseUrl,timeoutMs:80});
  await assert.rejects(c.regions(),{code:'NETWORK',operation:'/api/v1/region/list',httpStatus:200});assert.deepEqual(await c.regions(),[{region_name:'fixture-region'}]);assert.equal(calls,2);
});

test('HTTP 403 with HTML reports missing permission while retaining the login for other reads',async t=>{
  let calls=0;const baseUrl=await serve(t,(_q,r)=>{calls++;if(calls===1){r.statusCode=403;r.end('<html>Forbidden</html>');}else success(r);});const c=new WebClient({session,baseUrl});
  await assert.rejects(c.regions(),{code:'PERMISSION_DENIED',operation:'/api/v1/region/list',httpStatus:403});assert.deepEqual(await c.regions(),[{region_name:'fixture-region'}]);assert.equal(calls,2);
});

test('HTTP 429 is distinguishable from invalid login and is never automatically hammered',async t=>{
  let calls=0;const baseUrl=await serve(t,(_q,r)=>{calls++;if(calls===1){r.statusCode=429;r.setHeader('Retry-After','3');r.end('Too Many Requests');}else success(r);});const c=new WebClient({session,baseUrl});
  await assert.rejects(c.regions(),{code:'RATE_LIMITED',retryAfterSeconds:3,operation:'/api/v1/region/list',httpStatus:429});assert.equal(calls,1);assert.deepEqual(await c.regions(),[{region_name:'fixture-region'}]);
});

test('HTTP 503 with a non-JSON body remains a transient API error and the session can recover',async t=>{
  let calls=0;const baseUrl=await serve(t,(_q,r)=>{calls++;if(calls===1){r.statusCode=503;r.end('Service Unavailable');}else success(r);});const c=new WebClient({session,baseUrl});
  await assert.rejects(c.regions(),{code:'API_ERROR',retryable:true,operation:'/api/v1/region/list',httpStatus:503,providerCode:'HTTP503'});assert.equal(calls,1);assert.deepEqual(await c.regions(),[{region_name:'fixture-region'}]);
});

test('a null JSON envelope fails safely rather than throwing an internal TypeError',async t=>{
  const baseUrl=await serve(t,(_q,r)=>r.end('null'));const c=new WebClient({session,baseUrl});await assert.rejects(c.regions(),{code:'SCHEMA_CHANGED'});
});

test('business rejection preserves only safe provider metadata and never retries or exposes request and response contents',async t=>{
  let calls=0;const baseUrl=await serve(t,(q,r)=>{calls++;assert.equal(new URL(q.url,baseUrl).searchParams.get('instance_uuid'),'private-instance-marker');r.end(JSON.stringify({code:'FixtureCloneRejected',msg:'provider-message-marker',data:{token:'provider-secret-marker'}}));});
  const c=new WebClient({session,baseUrl});
  await assert.rejects(c.snapshot('private-instance-marker'),error=>{
    assert.equal(error.code,'API_ERROR');assert.equal(error.operation,'/api/v1/instance/snapshot');assert.equal(error.httpStatus,200);assert.equal(error.providerCode,'FixtureCloneRejected');assert.equal(error.retryable,undefined);
    const diagnostic=JSON.stringify({message:error.message,...error});for(const marker of ['private-instance-marker','provider-message-marker','provider-secret-marker','network-fixture',baseUrl,'sub_user'])assert.ok(!diagnostic.includes(marker),diagnostic);
    return true;
  });assert.equal(calls,1);assert.equal(c.authenticated,true);
});

test('unsafe provider business codes are replaced without leaking content into diagnostics',async t=>{
  const unsafeCodes=['Contains space','secret?token=provider-secret-marker','X'.repeat(65),'Alert\nINJECTED','<html>','', '1Invalid'];
  let calls=0;const baseUrl=await serve(t,(_q,r)=>{r.end(JSON.stringify({code:unsafeCodes[calls++],msg:'provider-message-marker'}));});const c=new WebClient({session,baseUrl});
  for(const _code of unsafeCodes)await assert.rejects(c.regions(),error=>{assert.equal(error.code,'API_ERROR');assert.equal(error.providerCode,'UnrecognizedCode');assert.equal(error.operation,'/api/v1/region/list');assert.equal(error.httpStatus,200);assert.equal(error.message,'AutoDL 拒绝了请求（UnrecognizedCode）');return true;});
  assert.equal(calls,unsafeCodes.length);
});

test('the exact provider insufficient-GPU code is distinguishable from unknown business errors',async t=>{
  let calls=0;const baseUrl=await serve(t,(_q,r)=>{calls++;r.end(JSON.stringify({code:'MachineGpuNumUpdateFailed',msg:'untrusted-provider-message'}));});const c=new WebClient({session,baseUrl});
  await assert.rejects(c.regions(),{code:'NO_STOCK',providerCode:'MachineGpuNumUpdateFailed',operation:'/api/v1/region/list',httpStatus:200});assert.equal(calls,1);assert.equal(c.authenticated,true);
});
