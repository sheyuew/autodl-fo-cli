import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, stat, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

// These tests catch an unintended submit before confirmation, duplicate jobs
// after a lost response, and altered parameters between review and submission.
async function fixture(t) {
  const {Controller} = await import('../lib/controller.mjs');
  const {Journal} = await import('../lib/journal.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'fo-cli-test-'));
  t.after(() => rm(dir, {recursive:true,force:true}));
  const jobs = [];
  let account = 'test:sub', changed = false, loseReply = false;
  const driver = {
    async resolve(spec) { return {account, mode:spec.mode, name:'training', instances:[{uuid:'source-1',name:'source',gpu:'vGPU-32GB',count:8}], spec}; },
    async account() { return account; },
    async stage(plan) { return {...plan.resolved, ...(changed ? {name:'changed'} : {})}; },
    async clickStart(plan) { jobs.push({marker:plan.marker}); if (loseReply) throw new Error('connection lost'); },
    async reconcile(plan) { return jobs.some(j=>j.marker===plan.marker) ? {accepted:true,task:'fixture job'} : {accepted:false}; }
  };
  const controller = new Controller(driver, new Journal(dir));
  return {controller, dir, jobs, driver, change:()=>{changed=true;}, switch:()=>{account='other';}, lose:()=>{loseReply=true;}};
}
test('preparing a plan does not start a job; wrong confirmation remains harmless', async t => {
  const f=await fixture(t), p=await f.controller.prepare({mode:'existing',instances:['source-1']});
  assert.equal(f.jobs.length,0);
  await assert.rejects(f.controller.start(p.id,'yes'),/确认/);
  assert.equal(f.jobs.length,0);
});
test('confirmed request is durable and a repeated request cannot create another job', async t=>{
  const f=await fixture(t),p=await f.controller.prepare({mode:'existing',instances:['source-1']});
  assert.equal((await f.controller.start(p.id,p.confirmation)).state,'accepted');
  assert.equal((await f.controller.start(p.id,p.confirmation)).state,'accepted');
  assert.equal(f.jobs.length,1);
  const saved=JSON.parse(await readFile(join(f.dir,p.id+'.json'),'utf8'));
  assert.equal(saved.state,'accepted');
  assert.equal((await stat(join(f.dir,p.id+'.json'))).mode & 0o777,0o600);
});
test('lost submit response is reconciled without clicking again', async t=>{
  const f=await fixture(t),p=await f.controller.prepare({mode:'existing',instances:['source-1']}); f.lose();
  assert.equal((await f.controller.start(p.id,p.confirmation)).state,'accepted');
  await f.controller.start(p.id,p.confirmation);
  assert.equal(f.jobs.length,1);
});
test('unconfirmed outcome survives a process restart and never resubmits',async t=>{
  const f=await fixture(t),p=await f.controller.prepare({mode:'existing',instances:['source-1']});
  f.driver.reconcile=async()=>({accepted:false});f.driver.clickStart=async()=>{throw new Error('lost');};
  assert.equal((await f.controller.start(p.id,p.confirmation)).state,'uncertain');
  f.driver.clickStart=async()=>{throw new Error('must not execute');};
  assert.equal((await f.controller.start(p.id,p.confirmation)).state,'uncertain');
});
test('account switch or changed staged configuration cannot start the reviewed plan',async t=>{
  const f=await fixture(t),p=await f.controller.prepare({mode:'existing',instances:['source-1']});f.switch();
  await assert.rejects(f.controller.start(p.id,p.confirmation),/账号/); assert.equal(f.jobs.length,0);
  const g=await fixture(t),q=await g.controller.prepare({mode:'existing',instances:['source-1']});g.change();
  await assert.rejects(g.controller.start(q.id,q.confirmation),/配置/); assert.equal(g.jobs.length,0);
});
test('journal rejects path traversal',async t=>{
  const f=await fixture(t); await assert.rejects(f.controller.result('../../etc/passwd'),/ID/);
});
test('crash after durable submitting marker becomes uncertain without another click',async t=>{
  const f=await fixture(t),p=await f.controller.prepare({mode:'existing',instances:['source-1']});
  p.state='submitting';await f.controller.journal.put(p);
  assert.equal((await f.controller.start(p.id,p.confirmation)).state,'uncertain');
  assert.equal(f.jobs.length,0);
});
