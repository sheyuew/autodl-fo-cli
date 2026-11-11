import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';
import {foPage} from '../lib/page.mjs';
test('doctor can identify a missing Fo panel without returning browser credentials',async()=>{
  const data={user:JSON.stringify({uuid:'fixture',sub_name:'sub'}),token:'secret-token'};
  const result=await vm.runInNewContext(`(${foPage.toString()})({op:'diagnose'})`,{
    localStorage:{getItem:k=>data[k]},location:{origin:'https://www.autodl.com'},
    document:{readyState:'complete',getElementById:()=>null}
  });
  assert.equal(result.fo,false);assert.equal(result.authenticated,true);assert.equal(result.origin,'https://www.autodl.com');
  assert.ok(!JSON.stringify(result).includes('secret-token'));
});
test('doctor reports an initializing document without treating inaccessible storage as a login',async()=>{
  const result=await vm.runInNewContext(`(${foPage.toString()})({op:'diagnose'})`,{
    localStorage:{getItem:()=>{throw new Error('SecurityError');}},location:{origin:'null'},
    document:{readyState:'loading',getElementById:()=>null}
  });
  assert.equal(result.authenticated,false);assert.equal(result.loading,true);assert.equal(result.account,'');
});
