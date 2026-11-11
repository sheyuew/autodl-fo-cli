import test from 'node:test';
import assert from 'node:assert/strict';
// A declined final review must send zero start requests, including non-TTY input.
test('declining the wizard confirmation never submits',async()=>{
  const {confirmAndStart}=await import('../lib/wizard.mjs');
  let sent=false;
  const result=await confirmAndStart({id:'a',confirmation:'启动 abc'},async()=>'',async()=>{sent=true;});
  assert.equal(result,null);assert.equal(sent,false);
});
test('yes submits the exact reviewed plan; the server still receives its plan-specific confirmation',async()=>{
  const {confirmAndStart}=await import('../lib/wizard.mjs');
  let request;
  await confirmAndStart({id:'abc',confirmation:'启动 abc'},async()=>'yes',async r=>{request=r;return r;});
  assert.deepEqual(request,{op:'start',id:'abc',confirmation:'启动 abc'});
});
test('no, empty and unrecognized answers all cancel without a request',async()=>{
  const {confirmAndStart}=await import('../lib/wizard.mjs');
  for(const answer of ['no','','y','启动 abc','anything']){
    let sent=false;
    assert.equal(await confirmAndStart({id:'abc',confirmation:'启动 abc'},async()=>answer,async()=>{sent=true;}),null);
    assert.equal(sent,false);
  }
});
