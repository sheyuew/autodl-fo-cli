import test from 'node:test';import assert from 'node:assert/strict';import {createServer} from 'node:http';import {once} from 'node:events';
const auth=await import('../login.mjs').catch(e=>{if(e.code==='ERR_MODULE_NOT_FOUND')return {};throw e;});
async function server(t,handler){const s=createServer(async(q,r)=>{let body='';for await(const b of q)body+=b;await handler(q,r,body?JSON.parse(body):{});});s.listen(0,'127.0.0.1');await once(s,'listening');t.after(()=>{s.closeAllConnections();s.close();});return `http://127.0.0.1:${s.address().port}`;}
const send=(r,data)=>r.end(JSON.stringify({code:'Success',data}));
const login=(...args)=>{assert.ok(auth.loginSubaccount,'Direct login is not implemented');return auth.loginSubaccount(...args);};

test('direct login hashes the password and exchanges the returned ticket at the subaccount passport endpoint',async t=>{
  const seen=[];const baseUrl=await server(t,(q,r,b)=>{seen.push(q.url);assert.equal(q.method,'POST');
    if(q.url==='/api/v1/sub_user/login'){assert.deepEqual(b,{sub_name:'alice@team',password:'5baa61e4c9b93f3f0682250b6cf8331b7ee68fd8'});send(r,{ticket:'fixture-ticket',user:{uuid:'team',id:123,sub_name:'alice@team',user_name:'alice'}});}
    else if(q.url==='/api/v1/sub_user/passport'){assert.equal(b.ticket,'fixture-ticket');assert.equal(typeof b.device.os.name,'string');assert.equal(typeof b.device.browser.name,'string');send(r,{token:'fixture-session-token'});}
    else{r.statusCode=404;r.end('{}');}
  });
  const session=await login({username:'alice@team',password:'password'},{baseUrl});
  assert.equal(session.token,'fixture-session-token');assert.equal(session.user.sub_name,'alice@team');
  assert.deepEqual(seen,['/api/v1/sub_user/login','/api/v1/sub_user/passport']);
  assert.ok(!JSON.stringify(session).includes('password'));assert.ok(!JSON.stringify(session).includes('fixture-ticket'));
});

test('a rejected login stops before token exchange and exposes no password or provider response',async t=>{
  let calls=0;const baseUrl=await server(t,(_q,r)=>{calls++;r.end(JSON.stringify({code:'PasswordWrong',msg:'password secret-from-server'}));});
  await assert.rejects(login({username:'alice@team',password:'password'},{baseUrl}),e=>e.code==='LOGIN_REJECTED'&&!e.message.includes('secret-from-server')&&!e.message.includes('password'));
  assert.equal(calls,1);
});

test('a login response naming another account is rejected before passport exchange',async t=>{
  let calls=0;const baseUrl=await server(t,(_q,r)=>{calls++;send(r,{ticket:'t',user:{id:1,sub_name:'bob@team'}});});
  await assert.rejects(login({username:'alice@team',password:'password'},{baseUrl}),{code:'ACCOUNT_MISMATCH'});assert.equal(calls,1);
});
