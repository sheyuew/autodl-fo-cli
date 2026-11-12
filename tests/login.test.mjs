import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import * as login from '../lib/login.mjs';

function browser(user={},token=''){
  const storage={user:JSON.stringify(user),token};
  return {evaluate:async(_session,expression)=>vm.runInNewContext(expression,{
    localStorage:{getItem:key=>storage[key]},
    document:{readyState:'complete'},location:{pathname:'/subAccountLogin'}
  })};
}

test('an unfinished browser login reports login required before comparing usernames',async()=>{
  await assert.rejects(()=>login.requireLogin(browser(),'session','alice@parent'),e=>e.code==='LOGIN_REQUIRED');
});

test('stale identity without a session is not an account mismatch',async()=>{
  await assert.rejects(()=>login.requireLogin(browser({uuid:'parent',sub_name:'bob@parent'}),'session','alice@parent'),e=>e.code==='LOGIN_REQUIRED');
});

test('a genuinely different authenticated account is still rejected',async()=>{
  await assert.rejects(()=>login.requireLogin(browser({uuid:'parent',sub_name:'bob@parent'},'PRIVATE_TOKEN'),'session','alice@parent'),e=>e.code==='ACCOUNT_MISMATCH');
});

test('matching authenticated identity is confirmed without exposing its session token',async()=>{
  const result=await login.requireLogin(browser({uuid:'parent',sub_name:'alice@parent'},'PRIVATE_TOKEN'),'session','alice@parent');
  assert.equal(result.authenticated,true);
  assert.equal(result.account,'parent:alice@parent');
  assert.ok(!JSON.stringify(result).includes('PRIVATE_TOKEN'));
});
