import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';

// Catch reporting a submitted or still-monitoring task as a completed GPU job,
// losing completion while the local machine is offline, and repeated desktop alerts.
test('completion is durable, account-scoped and delivered once across restarts',async t=>{
  const {Notifications}=await import('../lib/notifications.mjs');
  const dir=await mkdtemp(join(tmpdir(),'fo-notify-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  let n=new Notifications(dir,'alice');
  const task={name:'training [CLI-one]',status:'监控中',text:'等待空闲 GPU',source:null};
  await n.observe({account:'u:alice',tasks:[task]});
  assert.equal((await n.list(0)).events.length,0);
  await n.observe({account:'u:alice',tasks:[{...task,status:'已成功',text:'GPU 开机成功 实例：instance-123',source:'instance-123'}]});
  n=new Notifications(dir,'alice');
  await n.observe({account:'u:alice',tasks:[{...task,status:'已成功',text:'GPU 开机成功 实例：instance-123',source:'instance-123'}]});
  const result=await n.list(0);assert.equal(result.events.length,1);
  assert.equal(result.events[0].kind,'success');assert.equal(result.events[0].instanceUuid,'instance-123');
  assert.equal(result.events[0].tenant,'alice');assert.equal(result.events[0].account,'u:alice');
  assert.equal((await n.list(result.cursor)).events.length,0);
  await assert.rejects(n.observe({account:'other:bob',tasks:[]}),/账号/);
  assert.equal((await new Notifications(join(dir,'bob'),'bob').list(0)).events.length,0);
});
test('historical completions form the initial baseline; health failures alert once',async t=>{
  const {Notifications}=await import('../lib/notifications.mjs');
  const dir=await mkdtemp(join(tmpdir(),'fo-notify-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const n=new Notifications(dir,'owner');
  await n.observe({account:'owner',tasks:[{name:'old',status:'已成功',text:'old instance'}]});
  assert.equal((await n.list(0)).events.length,0);
  await n.failure('AutoDL 登录已过期');await n.failure('AutoDL 登录已过期');
  assert.equal((await n.list(0)).events.length,1);
  assert.equal((await n.list(0)).events[0].kind,'attention');
});
