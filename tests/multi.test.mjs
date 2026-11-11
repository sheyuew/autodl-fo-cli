import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

// Catch shared browser/state paths and a client selecting someone else's account.
test('tenant runtime separates profiles, socket, plans and desktop ports',async()=>{
  const {tenantRuntime}=await import('../lib/tenant.mjs');
  const a=tenantRuntime({id:'alice',slot:1}),b=tenantRuntime({id:'bob',slot:2});
  assert.equal(a.state,'/var/lib/fo-tenants/alice');
  assert.equal(a.user,'fo-u-alice');assert.equal(a.webPort,6081);
  for(const key of ['state','profile','socket','plans','display','webPort','vncPort','user'])assert.notEqual(a[key],b[key],key);
  assert.equal(tenantRuntime(null).id,'owner');
  for(const id of ['owner','../alice','alice;id','','Root','a'.repeat(25)])assert.throws(()=>tenantRuntime({id,slot:1}));
});
test('SSH entry refuses a shell, a client-selected tenant and another Unix identity',async()=>{
  const {authorizeSSH}=await import('../lib/tenant.mjs');
  assert.equal(authorizeSSH('fo-u-alice',{id:'alice',slot:1},'fo-rpc').id,'alice');
  assert.throws(()=>authorizeSSH('fo-u-bob',{id:'alice',slot:1},'fo-rpc'),/身份/);
  for(const command of ['id','bash','fo-rpc bob','fo-rpc; id',''])assert.throws(()=>authorizeSSH('fo-u-alice',{id:'alice',slot:1},command),/命令/);
});
test('account binding is private, survives restart and refuses account switches',async t=>{
  const {AccountBinding}=await import('../lib/tenant.mjs');
  const dir=await mkdtemp(join(tmpdir(),'fo-binding-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const a=new AccountBinding(dir),b=new AccountBinding(join(dir,'bob'));
  await assert.rejects(a.check({authenticated:false,account:''}),/登录/);
  await a.check({authenticated:true,account:'uuid:alice'});
  await b.check({authenticated:true,account:'other:bob'});
  await new AccountBinding(dir).check({authenticated:true,account:'uuid:alice'});
  await assert.rejects(a.check({authenticated:true,account:'other:bob'}),/绑定/);
  assert.equal(JSON.parse(await readFile(join(dir,'account-binding.json'),'utf8')).account,'uuid:alice');
});
test('journal files cannot be fetched from a different tenant even with a known plan ID',async t=>{
  const {Journal}=await import('../lib/journal.mjs');
  const dir=await mkdtemp(join(tmpdir(),'fo-isolation-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const a=new Journal(join(dir,'alice')),b=new Journal(join(dir,'bob'));
  await a.put({id:'12345678-1234-1234-1234-123456789abc',state:'prepared'});
  await assert.rejects(b.get('12345678-1234-1234-1234-123456789abc'),/ENOENT/);
});
