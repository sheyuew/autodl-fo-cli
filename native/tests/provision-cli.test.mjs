import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
const exec=promisify(execFile),entry=resolve('cli.mjs');
async function fixture(t){
 const home=await mkdtemp(join(tmpdir(),'fo-provision-cli-'));t.after(()=>rm(home,{recursive:true,force:true}));
 return async args=>{
  let p;try{p=await exec(process.execPath,[entry,...args,'--json'],{env:{...process.env,FO_LOCAL_HOME:home},timeout:15000});}
  catch(error){p=error;}
  return {code:p.code||0,json:JSON.parse(p.stdout),stderr:p.stderr};
 };
}
test('paid provisioning and automatic task starts cannot execute without the final yes and no submits nothing',async t=>{
 const run=await fixture(t);
 for(const args of [['provision','execute','plan'],['task','start','plan']]){
  const blocked=await run(args);assert.equal(blocked.code,2);assert.equal(blocked.json.code,'CONFIRMATION_REQUIRED');
  const no=await run([...args,'--confirm','no']);assert.equal(no.code,0);assert.equal(no.json.result.state,'cancelled');
 }
 const cancel=await run(['task','cancel','task','--confirm','no']);assert.equal(cancel.json.result.state,'cancelled');
});
test('new named commands accept capacity options and report login requirements instead of opening onboarding',async t=>{
 const run=await fixture(t);
 for(const args of [
  ['provision','catalog','--regions','north','--gpu','RTX 4090','--gpu-count','2'],
  ['provision','catalog','--machine-id','machine-string-id'],
  ['provision','prepare','create','--data','{}'],['task','prepare','--data','{}'],
  ['instance','prepare','one','expandDataDisk','--size-gb','100'],['task','list'],['notifications'],
 ]){
  const p=await run(args);assert.equal(p.json.ok,false,args.join(' '));assert.equal(p.json.code,'LOGIN_REQUIRED',args.join(' '));assert.ok(!p.stderr.includes('邀请码'));
 }
});
test('credentials cannot enter provisioning or persisted task policies through JSON arguments',async t=>{
 const run=await fixture(t);
 for(const command of [['provision','prepare','create'],['task','prepare']]){
  const p=await run([...command,'--data',JSON.stringify({password:'fixture-private-secret'})]);
  assert.equal(p.json.code,'CREDENTIALS_IN_ARGUMENTS');assert.ok(!JSON.stringify(p).includes('fixture-private-secret'));
 }
});
test('background task result polling has a separate JSON query rather than mixed watch output',async t=>{
 const run=await fixture(t);const p=await run(['task','watch','task']);assert.equal(p.code,2);assert.equal(p.json.code,'TTY_REQUIRED');
});
