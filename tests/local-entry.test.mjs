import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,mkdir,symlink,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';

const cli=resolve('cli.mjs');
async function fixture(t){
  const home=await mkdtemp(join(tmpdir(),'fo local entry '));
  t.after(()=>rm(home,{recursive:true,force:true}));
  const env={...process.env,FO_CLI_HOME:join(home,'settings'),FO_LOCAL_HOME:join(home,'local')};
  const run=(...args)=>spawnSync(process.execPath,[cli,...args],{env,encoding:'utf8',timeout:10000});
  return {home,env,run};
}

test('root help and the old http alias describe the local client without SSH onboarding',async t=>{
  const {run}=await fixture(t);
  for(const args of [['help'],['--help'],['-h'],['local','--help'],['http','--help']]){
    const result=run(...args);
    assert.equal(result.status,0,result.stderr);
    assert.match(result.stdout,/login/);
    assert.match(result.stdout,/instances/);
    assert.doesNotMatch(result.stdout,/一次性邀请码|接入公钥/);
  }
});

test('the default local entry ignores existing remote connection settings',async t=>{
  const f=await fixture(t);
  await mkdir(f.env.FO_CLI_HOME,{recursive:true});
  const path=join(f.env.FO_CLI_HOME,'config.json');
  // A damaged old remote config must not block or influence the local client.
  const existing='{"host":"root@must-not-connect.invalid","backend":"native-http"';
  await writeFile(path,existing);
  const result=f.run();
  assert.notEqual(result.status,0);
  assert.match(result.stderr,/TTY_REQUIRED|交互式终端|交互.*终端/);
  assert.doesNotMatch(result.stdout+result.stderr,/SSH|邀请码|must-not-connect/);
  assert.equal(await readFile(path,'utf8'),existing);
});

test('explicit remote mode keeps the optional legacy onboarding available',async t=>{
  const {run}=await fixture(t),result=run('remote','help');
  assert.equal(result.status,0,result.stderr);
  assert.match(result.stdout,/一次性邀请码/);
  assert.match(result.stdout,/keygen/);
});

test('importing the entry module has no login or connection side effects',async t=>{
  const {env}=await fixture(t);
  const result=spawnSync(process.execPath,['--input-type=module','-e',`await import(${JSON.stringify(pathToFileURL(cli).href)}); console.log('imported');`],{env,encoding:'utf8',timeout:10000});
  assert.equal(result.status,0,result.stderr);
  assert.equal(result.stdout,'imported\n');
  assert.equal(result.stderr,'');
});

test('the shell launcher runs local help when PATH has Node but no OpenSSH',async t=>{
  const f=await fixture(t),bin=join(f.home,'node only');
  await mkdir(bin);await symlink(process.execPath,join(bin,'node'));
  const result=spawnSync('/bin/bash',[resolve('fo'),'help'],{env:{...f.env,PATH:bin},encoding:'utf8',timeout:10000});
  assert.equal(result.status,0,result.stderr);
  assert.match(result.stdout,/instances/);
  assert.doesNotMatch(result.stdout+result.stderr,/OpenSSH/);
});
