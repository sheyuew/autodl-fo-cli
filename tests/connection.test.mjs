import test from 'node:test';import assert from 'node:assert/strict';
test('member client connects through forced RPC without root, runuser or shell parameters',async()=>{
  const {sshArgs}=await import('../lib/connection.mjs');
  const args=sshArgs({host:'fo-u-alice@example.test',port:22,identityFile:'~/.ssh/fo-alice',protocol:'multi-v1',knownHostsFile:'known_hosts'},'/bundle');
  assert.equal(args.at(-1),'fo-rpc');assert.equal(args.at(-2),'fo-u-alice@example.test');
  assert.ok(args.includes('UserKnownHostsFile=/bundle/known_hosts'));
  assert.ok(!args.join(' ').includes('runuser'));assert.ok(!args.includes('root@example.test'));
  assert.throws(()=>sshArgs({host:'fo-u-alice@example.test;id',port:22,identityFile:'x'},'/bundle'));
  const spaced=sshArgs({host:'fo-u-alice@example.test',port:22,identityFile:'key',protocol:'multi-v1',knownHostsFile:'known_hosts'},'/tmp/client with spaces');
  assert.ok(spaced.includes('UserKnownHostsFile="/tmp/client with spaces/known_hosts"'));
});
