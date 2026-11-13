import test from 'node:test';import assert from 'node:assert/strict';import{createServer}from'node:http';import{once}from'node:events';import{WebClient}from'../web-client.mjs';
const session={token:'fixture-token',user:{id:1,sub_name:'alice@team'}};
async function fixture(t){
 const seen=[],state={row:{uuid:'one',name:'example',status:'shutdown',charge_type:'payg',machine_id:'host',req_gpu_amount:2,root_password:'secret',jupyter_token:'token'},price:5000,disconnect:false};
 const server=createServer(async(q,r)=>{let raw='';for await(const p of q)raw+=p;const body=raw?JSON.parse(raw):null;seen.push({path:q.url,method:q.method,body});let data;
 if(q.url==='/api/v1/sub_user/instance')data={list:[state.row],result_total:1};
 else if(q.url.startsWith('/api/v1/sub_user/instance/snapshot?'))data={payg_price:state.price,expand_data_disk_size:1073741824,expand_system_disk_size:0,machine_info_snapshot:{cpu_num:8,memory:32000000000},root_password:'secret'};
 else if(q.url==='/api/v1/sub_user/order/price/preview')data={payg_price:state.price,data_disk_info:{data_disk_deal_daily_price:2400},prepay_expand_data_disk:false};
 else if(q.url==='/api/v1/sub_user/image/private/list')data={list:[{id:42,image_uuid:'img',name:'saved',status:'success',image_size:100,bucket_name:'private'}],result_total:1};
 else if(q.url.startsWith('/api/v1/sub_user/instance/monitor?'))data={uuid:'one',UsageInfo:{cpu_usage_percent:5}};
 else if(['/api/v1/sub_user/image/private/update','/api/v1/sub_user/image/private/delete','/api/v1/sub_user/instance/power_on','/api/v1/sub_user/instance/power_off','/api/v1/sub_user/instance/restart','/api/v1/sub_user/instance/name','/api/v1/sub_user/instance/timed/shutdown','/api/v1/sub_user/instance/image/save','/api/v1/sub_user/instance/release'].includes(q.url)){if(state.disconnect){q.socket.destroy();return;}data=null;}
 else {r.statusCode=404;r.end('{}');return;}
 r.end(JSON.stringify({code:'Success',data}));});server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{server.closeAllConnections();server.close();});
 return {seen,state,client:new WebClient({session,baseUrl:`http://127.0.0.1:${server.address().port}`})};
}
const writes=seen=>seen.filter(q=>/\/(power_on|power_off|restart|name|shutdown|save|release)$/.test(q.path));
test('power on prepares live compute and disk costs, and only a confirmed one-use plan submits',async t=>{
 const {client,seen}=await fixture(t);assert.equal(typeof client.prepareInstance,'function');
 const plan=await client.prepareInstance('powerOn','one');assert.equal(plan.quote.computeHourly,5);assert.equal(plan.quote.storageDaily,2.4);assert.equal(plan.quote.totalHourly,5.1);assert.equal(writes(seen).length,0);
 await assert.rejects(client.executeInstance(plan.id),{code:'CONFIRMATION_REQUIRED'});
 assert.deepEqual(await client.executeInstance(plan.id,{confirmed:true}),{accepted:true,action:'powerOn',instanceUuid:'one'});
 assert.deepEqual(writes(seen),[{path:'/api/v1/sub_user/instance/power_on',method:'POST',body:{instance_uuid:'one'}}]);
 await assert.rejects(client.executeInstance(plan.id,{confirmed:true}),{code:'PLAN_EXPIRED'});
});
test('ownership, state, arguments and unknown actions are rejected without a mutation',async t=>{
 const {client,seen,state}=await fixture(t);assert.equal(typeof client.prepareInstance,'function');
 await assert.rejects(client.prepareInstance('powerOff','other'),{code:'INSTANCE_REQUIRED'});
 await assert.rejects(client.prepareInstance('powerOff','one'),{code:'STATE_CHANGED'});
 await assert.rejects(client.prepareInstance('rename','one',{name:'x'.repeat(33)}),{code:'INVALID_REQUEST'});
 await assert.rejects(client.prepareInstance('timedShutdown','one',{shutdownAt:'tomorrow'}),{code:'STATE_CHANGED'});
 await assert.rejects(client.prepareInstance('arbitrary','one'),{code:'UNSUPPORTED_OPERATION'});
 state.row.status='running';await assert.rejects(client.prepareInstance('saveImage','one',{name:'backup'}),{code:'STATE_CHANGED'});
 assert.equal(writes(seen).length,0);
});
test('changed quotes or state invalidate the plan instead of spending against stale confirmation',async t=>{
 const {client,seen,state}=await fixture(t);assert.equal(typeof client.prepareInstance,'function');
 let plan=await client.prepareInstance('powerOn','one');state.price=6000;await assert.rejects(client.executeInstance(plan.id,{confirmed:true}),{code:'PLAN_CHANGED'});
 plan=await client.prepareInstance('powerOn','one');state.row.status='running';await assert.rejects(client.executeInstance(plan.id,{confirmed:true}),{code:'STATE_CHANGED'});assert.equal(writes(seen).length,0);
});
test('rename, timer cancellation, image save, stop and restart use the webpage methods and exact payloads',async t=>{
 const {client,seen,state}=await fixture(t);assert.equal(typeof client.prepareInstance,'function');
 const run=async(action,args)=>{const p=await client.prepareInstance(action,'one',args);return client.executeInstance(p.id,{confirmed:true});};
 await run('rename',{name:'new name'});await run('saveImage',{name:'backup'});state.row.status='running';await run('cancelShutdown');await run('restart');await run('powerOff');
 assert.deepEqual(writes(seen).map(x=>[x.path,x.method,x.body]),[
 ['/api/v1/sub_user/instance/name','PUT',{instance_uuid:'one',instance_name:'new name'}],
 ['/api/v1/sub_user/instance/image/save','POST',{instance_uuid:'one',image_name:'backup',try_again:false}],
 ['/api/v1/sub_user/instance/timed/shutdown','POST',{instance_uuid:'one',shutdown_at:null}],
 ['/api/v1/sub_user/instance/restart','POST',{instance_uuid:'one'}],
 ['/api/v1/sub_user/instance/power_off','POST',{instance_uuid:'one'}]]);
});
test('a lost mutation acknowledgement is uncertain and its plan cannot be retried',async t=>{
 const {client,seen,state}=await fixture(t);assert.equal(typeof client.prepareInstance,'function');const p=await client.prepareInstance('rename','one',{name:'new'});state.disconnect=true;
 await assert.rejects(client.executeInstance(p.id,{confirmed:true}),{code:'ACTION_UNCERTAIN'});await assert.rejects(client.executeInstance(p.id,{confirmed:true}),{code:'PLAN_EXPIRED'});assert.equal(writes(seen).length,1);
});
test('details, monitoring and image lists are usable without exposing unrelated provider credentials',async t=>{
 const {client}=await fixture(t);assert.equal(typeof client.instanceInfo,'function');const d=await client.instanceInfo('one');assert.equal(d.uuid,'one');assert.ok(!JSON.stringify(d).includes('secret'));assert.ok(!JSON.stringify(d).includes('jupyter_token'));
 assert.equal((await client.monitor('one')).UsageInfo.cpu_usage_percent,5);const images=await client.images();assert.equal(images[0].image_uuid,'img');assert.ok(!JSON.stringify(images).includes('bucket_name'));
});


test('image rename and delete resolve the provider ID from the current account and consume confirmed plans once',async t=>{
 const {client,seen}=await fixture(t);assert.equal(typeof client.prepareImage,'function');
 await assert.rejects(client.prepareImage('delete','not-mine'),{code:'IMAGE_REQUIRED'});
 const rename=await client.prepareImage('rename','img',{name:'new image'});await assert.rejects(client.executeImage(rename.id),{code:'CONFIRMATION_REQUIRED'});await client.executeImage(rename.id,{confirmed:true});
 await assert.rejects(client.executeImage(rename.id,{confirmed:true}),{code:'PLAN_EXPIRED'});
 const remove=await client.prepareImage('delete','img');await client.executeImage(remove.id,{confirmed:true});
 assert.deepEqual(seen.filter(x=>/private\/(update|delete)$/.test(x.path)),[
 {path:'/api/v1/sub_user/image/private/update',method:'POST',body:{image_id:42,image_name:'new image'}},
 {path:'/api/v1/sub_user/image/private/delete',method:'DELETE',body:{image_id:42}}]);
});
