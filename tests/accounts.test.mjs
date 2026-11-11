import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir} from 'node:os';
test('switching saved AutoDL accounts selects separate SSH connections without saving passwords',async t=>{
  const {Accounts}=await import('../lib/accounts.mjs');const dir=await mkdtemp(join(tmpdir(),'fo-accounts-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const path=join(dir,'config.json'),accounts=new Accounts(path);
  const alice={host:'fo-u-alice@example.test',identityFile:'/keys/alice',port:22,protocol:'multi-v1'};
  const bob={host:'fo-u-bob@example.test',identityFile:'/keys/bob',port:22,protocol:'multi-v1'};
  await accounts.remember({account:'a:alice',username:'alice@a',config:alice,password:'must-never-save'});
  await accounts.remember({account:'b:bob',username:'bob@b',config:bob});
  assert.equal((await accounts.list()).length,2);
  assert.deepEqual(await accounts.select('alice@a'),alice);assert.deepEqual(JSON.parse(await readFile(path)),alice);
  assert.deepEqual(await accounts.select('bob@b'),bob);assert.deepEqual(JSON.parse(await readFile(path)),bob);
  assert.ok(!(await readFile(join(dir,'accounts.json'),'utf8')).includes('must-never-save'));
  await assert.rejects(accounts.select('unknown'));assert.deepEqual(JSON.parse(await readFile(path)),bob);
});
