import test from 'node:test';import assert from 'node:assert/strict';
const key='ssh-ed25519 '+Buffer.concat([Buffer.from([0,0,0,11]),Buffer.from('ssh-ed25519'),Buffer.from([0,0,0,32]),Buffer.alloc(32,7)]).toString('base64');
test('provisioned SSH access is limited to that member RPC and viewer, with no inherited credentials',async()=>{
  const {memberFiles,cleanPublicKey}=await import('../lib/provision.mjs');
  assert.equal(cleanPublicKey(key+' alice@laptop'),key);
  for(const input of ['command="id" '+key,key+'\n'+key,'ssh-rsa garbage'])assert.throws(()=>cleanPublicKey(input));
  const files=memberFiles({id:'alice',slot:1},key);
  assert.match(files.ssh,/Match User fo-u-alice/);assert.match(files.ssh,/PermitOpen 127\.0\.0\.1:6081/);
  assert.match(files.ssh,/ForceCommand \/usr\/bin\/node \/opt\/fo-autodl\/multi\/ssh-entry.mjs/);
  assert.match(files.ssh,/AllowTcpForwarding local/);assert.match(files.ssh,/PermitTTY no/);
  assert.ok(!files.ssh.includes('root@'));assert.equal(files.key,key+'\n');
  assert.equal(files.env.FO_TENANT_CONFIG,'/etc/fo-autodl/tenants/alice.json');
  assert.equal(files.env.DISPLAY,':101');assert.equal(files.env.HOME,'/var/lib/fo-tenants/alice');
});
test('a member invitation contains only the assigned SSH connection and pinned server public key',async()=>{
  const {memberInvitation}=await import('../lib/provision.mjs');
  const result=memberInvitation({id:'alice',slot:1,publicKey:key,privateData:'must-not-leak'},'server.example.test',key);
  assert.deepEqual(result,{kind:'fo-cli-invite',version:1,host:'fo-u-alice@server.example.test',port:22,serverHostKey:key});
  for(const host of ['example.test;id','root@example.test',''])assert.throws(()=>memberInvitation({id:'alice',slot:1},host,key));
  assert.throws(()=>memberInvitation({id:'alice',slot:1},'example.test','bad key'));
});
