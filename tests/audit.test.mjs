import test from 'node:test';
import assert from 'node:assert/strict';

test('RPC audit correlates queued, started, login stages and completion without retaining secrets',async()=>{
  const {RpcAudit}=await import('../lib/audit.mjs');
  const records=[],audit=new RpcAudit('alice',line=>records.push(JSON.parse(line)));
  const request={op:'login-password',username:'PRIVATE_USERNAME',password:'PRIVATE_PASSWORD',token:'PRIVATE_TOKEN'};
  const trace=audit.request(request.op);
  const result=await trace.run(async()=>{
    trace.login({state:'loading',password:request.password,username:request.username,token:request.token});
    trace.login({state:'submitted'});
    return {state:'verification',reason:'timeout',password:request.password,token:request.token};
  });
  assert.equal(result.state,'verification');
  assert.deepEqual(records.map(x=>x.event),['rpc.received','rpc.started','login.stage','login.stage','rpc.finished']);
  assert.ok(records.every(x=>x.requestId===trace.id&&x.tenant==='alice'));
  assert.equal(records.at(-1).state,'verification');
  assert.equal(records.at(-1).reason,'timeout');
  for(const value of [request.password,request.token,request.username])assert.ok(!JSON.stringify(records).includes(value));
});

test('RPC audit records failure codes without logging exception text or browser credentials',async()=>{
  const {RpcAudit}=await import('../lib/audit.mjs');
  const records=[],audit=new RpcAudit('alice',line=>records.push(JSON.parse(line)));
  const error=Object.assign(new Error('PRIVATE_PASSWORD PRIVATE_TOKEN'),{code:'LOGIN_REQUIRED'});
  await assert.rejects(()=>audit.request('activate').run(async()=>{throw error;}),e=>e===error);
  assert.equal(records.at(-1).ok,false);
  assert.equal(records.at(-1).code,'LOGIN_REQUIRED');
  assert.ok(!JSON.stringify(records).includes('PRIVATE_PASSWORD'));
  assert.ok(!JSON.stringify(records).includes('PRIVATE_TOKEN'));
});
