import test from 'node:test';import assert from 'node:assert/strict';import {createServer} from 'node:http';import {once} from 'node:events';import {WebClient} from '../web-client.mjs';
const session={token:'network-fixture',user:{id:'fixture',sub_name:'alice@team'},appVersion:'1.2.3'};
async function serve(t,handler){const server=createServer(handler);server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{server.closeAllConnections();server.close();});return `http://127.0.0.1:${server.address().port}`;}
const success=r=>r.end(JSON.stringify({code:'Success',data:[{region_name:'fixture-region'}]}));

test('a disconnected socket fails once and the same session can read again when the network returns',async t=>{
  let calls=0;const baseUrl=await serve(t,(q,r)=>{calls++;if(calls===1)q.socket.destroy();else success(r);});const c=new WebClient({session,baseUrl});
  await assert.rejects(c.regions(),{code:'NETWORK'});assert.equal(calls,1);assert.deepEqual(await c.regions(),[{region_name:'fixture-region'}]);assert.equal(calls,2);
});

test('a timeout while reading a response body is a network failure and does not invalidate the session',async t=>{
  let calls=0;const baseUrl=await serve(t,(_q,r)=>{calls++;if(calls===1){r.writeHead(200,{'Content-Type':'application/json'});r.write('{"code":"Success","data":');}else success(r);});const c=new WebClient({session,baseUrl,timeoutMs:80});
  await assert.rejects(c.regions(),{code:'NETWORK'});assert.deepEqual(await c.regions(),[{region_name:'fixture-region'}]);assert.equal(calls,2);
});

test('HTTP 403 with HTML reports missing permission while retaining the login for other reads',async t=>{
  let calls=0;const baseUrl=await serve(t,(_q,r)=>{calls++;if(calls===1){r.statusCode=403;r.end('<html>Forbidden</html>');}else success(r);});const c=new WebClient({session,baseUrl});
  await assert.rejects(c.regions(),{code:'PERMISSION_DENIED'});assert.deepEqual(await c.regions(),[{region_name:'fixture-region'}]);assert.equal(calls,2);
});

test('HTTP 429 is distinguishable from invalid login and is never automatically hammered',async t=>{
  let calls=0;const baseUrl=await serve(t,(_q,r)=>{calls++;if(calls===1){r.statusCode=429;r.setHeader('Retry-After','3');r.end('Too Many Requests');}else success(r);});const c=new WebClient({session,baseUrl});
  await assert.rejects(c.regions(),{code:'RATE_LIMITED',retryAfterSeconds:3});assert.equal(calls,1);assert.deepEqual(await c.regions(),[{region_name:'fixture-region'}]);
});

test('HTTP 503 with a non-JSON body remains a transient API error and the session can recover',async t=>{
  let calls=0;const baseUrl=await serve(t,(_q,r)=>{calls++;if(calls===1){r.statusCode=503;r.end('Service Unavailable');}else success(r);});const c=new WebClient({session,baseUrl});
  await assert.rejects(c.regions(),{code:'API_ERROR',retryable:true});assert.deepEqual(await c.regions(),[{region_name:'fixture-region'}]);
});

test('a null JSON envelope fails safely rather than throwing an internal TypeError',async t=>{
  const baseUrl=await serve(t,(_q,r)=>r.end('null'));const c=new WebClient({session,baseUrl});await assert.rejects(c.regions(),{code:'SCHEMA_CHANGED'});
});
