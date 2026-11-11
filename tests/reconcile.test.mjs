import test from 'node:test';import assert from 'node:assert/strict';import {BrowserDriver} from '../lib/browser.mjs';
test('a historical completed task cannot acknowledge a new request for the same source',async()=>{
  const driver=new BrowserDriver(null,null);let reads=0;
  const old={source:'s1',name:'old',status:'已成功'},current={source:'s1',name:'new',status:'监控中'};
  driver.status=async()=>({tasks:++reads===1?[old]:[old,current]});
  const result=await driver.reconcile({resolved:{mode:'existing',instances:[{uuid:'s1'}],beforeCounts:{s1:1}}});
  assert.equal(result.accepted,true);assert.equal(result.tasks[0].name,'new');
});
