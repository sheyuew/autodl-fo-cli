import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,writeFile,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join} from 'node:path';import {execFileSync} from 'node:child_process';
const key=n=>'ssh-ed25519 '+Buffer.concat([Buffer.from([0,0,0,11]),Buffer.from('ssh-ed25519'),Buffer.from([0,0,0,32]),Buffer.alloc(32,n)]).toString('base64');
async function fixture(t){const dir=await mkdtemp(join(tmpdir(),'fo-enroll-'));t.after(()=>rm(dir,{recursive:true,force:true}));return dir;}
test('invitation transports a restricted bootstrap identity that OpenSSH can read and pins the server',async t=>{
  const {EnrollmentStore,decodeInvite,bootstrapIdentity}=await import('../lib/enrollment.mjs');
  const dir=await fixture(t),store=new EnrollmentStore(dir);let code;const oldMask=process.umask(0o077);
  try{code=await store.issue({tenant:'alice',host:'server.example.test',serverHostKey:key(7)});}finally{process.umask(oldMask);}
  const invite=decodeInvite(code);assert.equal(invite.host,'server.example.test');assert.equal(invite.tenant,'alice');
  const identity=bootstrapIdentity(invite.seed),file=join(dir,'bootstrap');await writeFile(file,identity.privateKey,{mode:0o600});
  assert.equal(execFileSync('ssh-keygen',['-y','-f',file],{encoding:'utf8'}).trim().split(/\s+/).slice(0,2).join(' '),identity.publicKey);
  assert.match(await readFile(join(dir,'authorized_keys'),'utf8'),/^restrict,command=".*enroll-entry\.mjs [a-f0-9]{32}" ssh-ed25519 /);
  assert.equal((await stat(join(dir,'authorized_keys'))).mode&0o777,0o644,'sshd must read the bootstrap public keys even when the administrator uses umask 077');
  assert.equal((await stat(join(dir,invite.id+'.json'))).mode&0o777,0o600);
  for(const bad of ['FO1-bad',code+'?',code.replace('FO1-','OTHER-')])assert.throws(()=>decodeInvite(bad));
  await assert.rejects(store.issue({tenant:'owner',host:'server.example.test',serverHostKey:key(7)}));
});
test('an invitation binds once, survives restart, permits same-key recovery and rejects another key',async t=>{
  const {EnrollmentStore,decodeInvite}=await import('../lib/enrollment.mjs');const dir=await fixture(t);
  let provisions=0;const provision=async record=>{provisions++;return {host:'fo-u-'+record.tenant+'@server.example.test'};};
  let store=new EnrollmentStore(dir,{provision});const code=await store.issue({tenant:'alice',host:'server.example.test',serverHostKey:key(7)}),{id}=decodeInvite(code);
  const [a,b]=await Promise.allSettled([store.redeem(id,key(1)),store.redeem(id,key(2))]);
  assert.equal(a.status,'fulfilled');assert.equal(b.status,'rejected');assert.equal(provisions,1);
  store=new EnrollmentStore(dir,{provision});assert.deepEqual(await store.redeem(id,key(1)),a.value);assert.equal(provisions,1);
  await assert.rejects(store.redeem(id,key(2)),/已绑定/);
});
test('expired, revoked or unknown invitations never provision a tenant',async t=>{
  const {EnrollmentStore,decodeInvite}=await import('../lib/enrollment.mjs');const dir=await fixture(t);let now=1000,provisions=0;
  const store=new EnrollmentStore(dir,{now:()=>now,provision:async()=>{provisions++;}});
  const a=decodeInvite(await store.issue({tenant:'alice',host:'server.example.test',serverHostKey:key(7),ttlMs:1000}));
  now=2001;await assert.rejects(store.redeem(a.id,key(1)),/过期/);
  const b=decodeInvite(await store.issue({tenant:'bob',host:'server.example.test',serverHostKey:key(7)}));
  await store.revoke(b.id);await assert.rejects(store.redeem(b.id,key(1)),/撤销/);
  await assert.rejects(store.redeem('../alice',key(1)));assert.equal(provisions,0);
});
