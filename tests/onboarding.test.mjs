import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
const cli=resolve('cli.mjs');
async function fixture(t){
  const dir=await mkdtemp(join(tmpdir(),'fo-onboarding-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const key=join(dir,'my key');
  const p=spawnSync('ssh-keygen',['-t','ed25519','-N','','-f',key],{encoding:'utf8'});assert.equal(p.status,0,p.stderr);
  const pub=(await readFile(key+'.pub','utf8')).trim().split(/\s+/).slice(0,2).join(' ');
  const home=join(dir,'settings');
  const run=(...args)=>spawnSync(process.execPath,[cli,...args],{encoding:'utf8',env:{...process.env,FO_CLI_HOME:home},timeout:15000});
  return {dir,key,pub,home,run};
}
test('help works before an account is configured',async t=>{
  const f=await fixture(t),p=f.run('help');assert.equal(p.status,0,p.stderr);assert.match(p.stdout,/setup/);assert.match(p.stdout,/keygen/);
});
test('importing an invitation stores a pinned server key and the member private-key path without contacting the server',async t=>{
  const f=await fixture(t),file=join(f.dir,'alice.connection.json');
  await writeFile(file,JSON.stringify({kind:'fo-cli-invite',version:1,host:'fo-u-alice@example.test',port:2222,serverHostKey:f.pub}));
  const p=f.run('setup',file,'--key',f.key);assert.equal(p.status,0,p.stderr);
  const c=JSON.parse(await readFile(join(f.home,'config.json'),'utf8'));
  assert.equal(c.host,'fo-u-alice@example.test');assert.equal(c.protocol,'multi-v1');assert.equal(c.identityFile,f.key);
  assert.equal(await readFile(join(f.home,c.knownHostsFile),'utf8'),'[example.test]:2222 '+f.pub+'\n');
  if(process.platform!=='win32')assert.equal((await stat(join(f.home,'config.json'))).mode&0o777,0o600);
});
test('an invalid or root invitation cannot overwrite a working connection',async t=>{
  const f=await fixture(t),file=join(f.dir,'invite.json');
  const invite={kind:'fo-cli-invite',version:1,host:'fo-u-alice@example.test',port:22,serverHostKey:f.pub};
  await writeFile(file,JSON.stringify(invite));assert.equal(f.run('setup',file,'--key',f.key).status,0);
  const before=await readFile(join(f.home,'config.json'),'utf8');
  for(const bad of [{...invite,host:'root@example.test'},{...invite,serverHostKey:'not a host key'}]){
    await writeFile(file,JSON.stringify(bad));assert.notEqual(f.run('setup',file,'--key',f.key).status,0);
    assert.equal(await readFile(join(f.home,'config.json'),'utf8'),before);
  }
});
test('creating a member key twice reuses the key instead of replacing access credentials',async t=>{
  const f=await fixture(t),key=join(f.dir,'new-member');
  let p=f.run('keygen','--key',key);assert.equal(p.status,0,p.stderr);
  const privateBefore=await readFile(key,'utf8'),publicBefore=await readFile(key+'.pub','utf8');
  p=f.run('keygen','--key',key);assert.equal(p.status,0,p.stderr);
  assert.equal(await readFile(key,'utf8'),privateBefore);assert.equal(await readFile(key+'.pub','utf8'),publicBefore);
  assert.match(p.stdout,/ssh-ed25519 /);assert.ok(!p.stdout.includes('PRIVATE KEY'));
});
