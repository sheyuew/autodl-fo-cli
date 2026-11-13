import test from 'node:test';import assert from 'node:assert/strict';import{createServer}from'node:http';import{once}from'node:events';import{runTerminal}from'./terminal-utils.mjs';
test('instance terminal shows live costs, cancels power on with no, and renames once with yes',{timeout:20000},async t=>{
 const writes=[],imageWrites=[];const row={uuid:'instance-one',name:'managed-instance',status:'shutdown',charge_type:'payg',machine_id:'host',req_gpu_amount:1,root_password:'hidden-root'};
 const server=createServer(async(q,r)=>{let raw='';for await(const p of q)raw+=p;const b=raw?JSON.parse(raw):{};let data;
 if(q.url.endsWith('/sub_user/login'))data={ticket:'ticket',user:{id:1,sub_name:'alice@team'}};
 else if(q.url.endsWith('/sub_user/passport'))data={token:'hidden-token'};
 else if(q.url==='/api/v1/sub_user/instance')data={list:[row],result_total:1};
 else if(q.url.startsWith('/api/v1/sub_user/instance/snapshot?'))data={expand_data_disk_size:1073741824,expand_system_disk_size:0};
 else if(q.url==='/api/v1/sub_user/order/price/preview')data={payg_price:3000,data_disk_info:{data_disk_deal_daily_price:2400}};
 else if(q.url==='/api/v1/sub_user/image/private/list')data={list:[{id:44,image_uuid:'img',name:'fixture-image',status:'success'}],result_total:1};
 else if(q.url==='/api/v1/sub_user/image/private/update'){imageWrites.push(b);data=null;}
 else if(q.url==='/api/v1/sub_user/instance/name'){writes.push(b);data=null;}
 else assert.fail('unexpected API: '+q.url);
 r.end(JSON.stringify({code:'Success',data}));});server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{server.closeAllConnections();server.close();});
 const result=await runTerminal({baseUrl:`http://127.0.0.1:${server.address().port}`,steps:[
 {wait:'AutoDL 子账号：',send:'alice@team\n'},{wait:'密码（不回显）：',send:'fixture-password\n'},
 {wait:'选择操作',send:'5\n'},{wait:'选择管理实例编号',send:'1\n'},
 {wait:'实例操作',send:'4\n'},{wait:'确认提交 [yes/no]',send:'no\n'},
 {wait:'实例操作',count:2,send:'9\n'},{wait:'实例新名称',send:'renamed\n'},
 {wait:'确认提交 [yes/no]',count:2,send:'maybe\n'},{wait:'确认提交 [yes/no]',count:3,send:'yes\n'},
 {wait:'实例操作',count:3,send:'q\n'},{wait:'选择操作',count:2,send:'6\n'},
 {wait:'镜像操作',send:'1\n'},{wait:'所选镜像',send:'1\n'},{wait:'镜像新名称',send:'image-renamed\n'},
 {wait:'确认提交 [yes/no]',count:4,send:'yes\n'},{wait:'镜像操作',count:2,send:'q\n'},{wait:'选择操作',count:3,send:'q\n'}]},t);
 assert.equal(result.code,0,result.error);assert.match(result.output,/计算.*3\.000.*小时/);assert.match(result.output,/存储.*2\.400.*天/);assert.match(result.output,/总计.*3\.100/);assert.ok(result.output.includes('已取消'));assert.deepEqual(writes,[{instance_uuid:'instance-one',instance_name:'renamed'}]);
 assert.deepEqual(imageWrites,[{image_id:44,image_name:'image-renamed'}]);
 for(const secret of ['hidden-root','hidden-token','fixture-password'])assert.ok(!result.output.includes(secret));
});
