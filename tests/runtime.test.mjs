import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';
test('Fo storage adapter persists tasks outside website storage and defaults to terminal notifications',async()=>{
  const {installGM}=await import('../lib/runtime.mjs');let saved;
  const context={__saved:null,__save:async value=>{saved=structuredClone(value);},addEventListener:()=>{}};
  vm.runInNewContext(`(${installGM.toString()})(__saved,__save)`,context);
  const fallback={settings:{sound:true,desktop:true},tasks:[]};
  const state=context.GM_getValue('autodl-helper-v1',fallback);assert.equal(state.settings.sound,false);assert.equal(state.settings.desktop,false);
  state.tasks.push({id:'alice-task'});context.GM_setValue('autodl-helper-v1',state);
  await context.__fo_flush();context.__saved=saved;
  vm.runInNewContext(`(${installGM.toString()})(__saved,__save)`,context);
  assert.equal(context.GM_getValue('autodl-helper-v1',fallback).tasks[0].id,'alice-task');
  assert.equal(saved.tasks[0].id,'alice-task');
});
test('runtime rejects modified upstream code before installing it',async()=>{
  const {FoRuntime}=await import('../lib/runtime.mjs');assert.throws(()=>new FoRuntime({},'modified'),/校验/);
});
