import test from 'node:test';import assert from 'node:assert/strict';
const context={account:'id:chenrui',instances:[{uuid:'s1',name:'source',gpu:'A',count:8,region:'r1'}],regions:[{id:'r1',name:'一区',signs:['a']}],gpus:[{name:'A',chip_corp:'nvidia',cpu_arch:'x86'},{name:'B',chip_corp:'nvidia',cpu_arch:'x86'}],drivers:['550.1'],images:[{type:'private',uuid:'i1',name:'image',chip_corp:'nvidia',cpu_arch:'x86'}],activeSources:[]};
const filters={gpus:['B','A'],gpuCount:4,minMemoryGb:30,minExpandGb:0,expandGb:0,driver:{mode:'any',value:''}};
test('clone preserves original eight-GPU source while applying four-GPU fallback filters',async()=>{
  const {resolveSpec}=await import('../lib/spec.mjs');const p=resolveSpec({mode:'clone',instances:['s1'],...filters},context);
  assert.equal(p.instances[0].count,8);assert.equal(p.filters.gpuCount,4);assert.deepEqual(p.filters.gpus,['B','A']);assert.equal(p.regions[0].id,'r1');
});
test('new instance resolves live image, ordered GPU/region choices and requested expansion',async()=>{
  const {resolveSpec}=await import('../lib/spec.mjs');const p=resolveSpec({mode:'new',...filters,regions:['r1'],imageType:'private',image:'i1',expandGb:100,name:'training'},context);
  assert.equal(p.image.name,'image');assert.equal(p.filters.expandGb,100);assert.equal(p.name,'training');
});
test('final preview includes the new task name and price policy',async()=>{
  const {resolveSpec,describePlan}=await import('../lib/spec.mjs');
  const p=resolveSpec({mode:'new',...filters,regions:['r1'],imageType:'private',image:'i1',name:'training-review'},context);
  assert.match(describePlan(p),/任务名称：training-review/);
  assert.match(describePlan(p),/没有价格上限/);
});
test('rejects invalid quantity, unknown image, duplicate source task, incompatible architecture',async()=>{
  const {resolveSpec}=await import('../lib/spec.mjs');
  for(const gpuCount of [0,-1,1.2,NaN])assert.throws(()=>resolveSpec({mode:'clone',instances:['s1'],...filters,gpuCount},context),/数量/);
  assert.throws(()=>resolveSpec({mode:'new',...filters,regions:['r1'],imageType:'private',image:'missing'},context),/镜像/);
  assert.throws(()=>resolveSpec({mode:'existing',instances:['s1']},{...context,activeSources:['s1']}),/已有/);
  assert.throws(()=>resolveSpec({mode:'new',...filters,regions:['r1'],imageType:'private',image:'i1'},{...context,images:[{type:'private',uuid:'i1',chip_corp:'amd',cpu_arch:'arm'}]}),/架构/);
});
