import test from 'node:test';import assert from 'node:assert/strict';
const {watchTransfers}=await import('../transfer-watch.mjs').catch(e=>{if(e.code==='ERR_MODULE_NOT_FOUND')return {};throw e;});
test('transfer monitoring reports actual terminal status once and never treats queue acceptance as completion',async()=>{
 assert.equal(typeof watchTransfers,'function');let reads=0;const notices=[],updates=[];
 const panel={taskHistory:async()=>{reads++;return {task_pre:[],task_doing:reads<3?[{task_id:'t',file_name:'a.bin',progress:{current:reads,total:10}}]:[],task_done:reads>=3?[{task_id:'t',file_name:'a.bin',status:'success'}]:[]};}};
 const result=await watchTransfers(panel,{intervalMs:1,onUpdate:x=>updates.push(x),notify:(...x)=>notices.push(x)});assert.equal(result.completed,1);assert.equal(notices.length,1);assert.match(notices[0][1],/a.bin/);assert.equal(reads,3);assert.ok(updates.length>=2);
});
test('a missing task is unresolved until cancelled, and an empty queue has no completion notification',async()=>{
 assert.equal(typeof watchTransfers,'function');const notices=[];let reads=0;const c=new AbortController();
 const panel={taskHistory:async()=>{reads++;if(reads===3)c.abort();return{task_pre:[],task_doing:reads===1?[{task_id:'t',file_name:'a.bin'}]:[],task_done:[]};}};
 const result=await watchTransfers(panel,{intervalMs:1,signal:c.signal,notify:(...x)=>notices.push(x)});assert.equal(result.pending,1);assert.equal(notices.length,0);
 const empty=await watchTransfers({taskHistory:async()=>({task_pre:[],task_doing:[],task_done:[]})},{notify:(...x)=>notices.push(x)});assert.equal(empty.pending,0);assert.equal(notices.length,0);
});
test('failed and cancelled transfers receive their actual result instead of success',async()=>{
 assert.equal(typeof watchTransfers,'function');let count=0;const notices=[];const panel={taskHistory:async()=>++count===1?{task_pre:[{task_id:'e',file_name:'bad'},{task_id:'c',file_name:'stop'}],task_doing:[],task_done:[]}:{task_pre:[],task_doing:[],task_done:[{task_id:'e',file_name:'bad',status:'error'},{task_id:'c',file_name:'stop',status:'cancel'}]}};
 const r=await watchTransfers(panel,{intervalMs:1,notify:(...x)=>notices.push(x)});assert.equal(r.completed,2);assert.ok(notices.some(x=>x[1].includes('失败')));assert.ok(notices.some(x=>x[1].includes('取消')));
});

test('unavailable desktop notifications do not discard terminal results or the remaining completions',async()=>{
 let reads=0;const messages=[];const panel={taskHistory:async()=>++reads===1?{task_pre:[{task_id:1},{task_id:2}],task_doing:[],task_done:[]}:{task_pre:[],task_doing:[],task_done:[{task_id:1,status:'success'},{task_id:2,status:'success'}]}};
 const r=await watchTransfers(panel,{intervalMs:1,onResult:x=>messages.push(x),notify:async()=>{throw new Error('no desktop');}});assert.equal(r.completed,2);assert.ok(messages.some(x=>x.includes('桌面提醒')));
});
