const stopped=new Set(['shutdown','shutdown_by_starting_error','shutdown_by_running_error']);
const fail=(code,message)=>Object.assign(new Error(message),{code});
function choices(rows,label){rows.forEach((row,i)=>console.log(`${i+1}. ${label(row)}`));}
async function choose(rows,prompt,label,{ask}){
 if(!rows.length){console.log('当前没有可选项目，请查询其他条件。');return;}
 choices(rows,label);
 for(;;){const answer=await ask(prompt+'（q 返回）：');if(answer==='q')return;const index=Number(answer)-1;if(Number.isInteger(index)&&rows[index])return rows[index];console.log('请选择列表中的编号。');}
}
async function number(prompt,{ask},{min=0,max=Number.MAX_SAFE_INTEGER,integer=true}={}){
 for(;;){const text=await ask(prompt+'（q 返回）：');if(text==='q')return;const n=Number(text);if(text!==''&&Number.isFinite(n)&&n>=min&&n<=max&&(!integer||Number.isSafeInteger(n)))return n;console.log(min===Number.MIN_VALUE?'请输入大于 0 的数字。':`请输入${integer?'整数':'数字'}，范围 ${min}～${max}。`);}
}
async function yesNo(prompt,{ask}){
 for(;;){const text=(await ask(prompt+' [yes/no，q 返回]：')).toLowerCase();if(text==='q')return;if(text==='yes')return true;if(text==='no')return false;console.log('请输入 yes 或 no。');}
}
export function printQuote(q){
 if(!q||!Number.isFinite(q.storageDaily))throw fail('QUOTE_UNAVAILABLE','未取得完整存储费用，不能确认付费操作');
 if(Number.isFinite(q.computeHourly))console.log(`计算费用：¥${q.computeHourly.toFixed(3)}/小时；存储费用：¥${q.storageDaily.toFixed(3)}/天。`);
 else console.log(`存储费用：¥${q.storageDaily.toFixed(3)}/天。`);
 if(Number.isFinite(q.dataDiskDaily))console.log(`数据盘：¥${q.dataDiskDaily.toFixed(3)}/天。`);
 if(Number.isFinite(q.systemDiskDaily)&&q.systemDiskDaily>0)console.log(`已有系统盘费用：¥${q.systemDiskDaily.toFixed(3)}/天。`);
 if(Number.isFinite(q.totalHourly))console.log(`运行总计折合：¥${q.totalHourly.toFixed(3)}/小时。`);
 console.log('存储按平台原计费周期结算，关机后仍可能收费。');
}
async function location(client,io){
 const region=await choose((await client.regions()).filter(r=>r.visible==='all'&&r.used_for==='all'),'选择地区编号',r=>`${r.region_name} (${r.region_sign})`,io);if(!region)return;
 const gpu=await choose((await client.gpuTypes()).filter(g=>g.chip_corp!=='cpu'),'选择 GPU 型号编号',g=>g.gpu_name,io);if(!gpu)return;
 const gpuCount=await number('GPU 卡数',io,{min:1,max:64});if(gpuCount===undefined)return;
 return {regionSigns:[region.region_sign],gpuNames:[gpu.gpu_name],gpuCount};
}
async function provisioningArgs(client,mode,io,{monitor=false}={}){
 const conditions=await location(client,io);if(!conditions)return;
 const machines=monitor?await client.machines({...conditions,idle:0}):(await client.provisionCatalog(conditions)).machines;
 if(monitor)console.log('选择参考主机获取兼容镜像；抢卡会在所选地区和 GPU 型号内匹配可用主机。');
 const machine=await choose(machines,'选择主机编号',m=>`${m.region_name||m.region_sign} / ${m.gpu_name} / 空闲 ${m.gpu_idle_num} 卡 / 免费数据盘 ${Number(m.max_instance_disk_size)/(1024**3)} GB / 驱动 ${m.driver_version||'—'} / 主机 ${m.machine_id}`,io);if(!machine)return;
 const args={machineId:machine.machine_id,gpuCount:conditions.gpuCount};
 if(mode==='create'){
  const catalog=await client.provisionCatalog({machineId:machine.machine_id,gpuCount:conditions.gpuCount});
  const type=await choose([{type:'base',name:'基础镜像'},{type:'private',name:'当前账号可用的私有镜像'}],'选择镜像类型编号',r=>r.name,io);if(!type)return;
  const image=await choose(catalog.images.filter(r=>r.imageType===type.type),'选择镜像编号',r=>`${r.name} / CUDA或MUSA ${r.cudaVersion||'—'} / ${r.imageUuid}`,io);if(!image)return;
  args.imageType=type.type;args.imageUuid=image.imageUuid;
 }else{
  const source=await choose((await client.instances()).filter(r=>stopped.has(r.status)&&r.charge_type==='payg'),'选择已关机的克隆源实例编号',r=>`${r.name||r.uuid} (${r.uuid})`,io);if(!source)return;
  args.sourceInstanceUuid=source.uuid;
  const copy=await yesNo('是否同时复制源实例数据盘',io);if(copy===undefined)return;args.copyDataDisk=copy;
 }
 console.log('额外数据盘是付费扩容总量，基础免费容量另计；0 表示只用免费数据盘。');
 args.dataDiskGB=await number('额外付费数据盘 GB',io,{max:100000});if(args.dataDiskGB===undefined)return;
 args.name=await io.ask('新实例名称（回车使用平台默认名称，q 返回）：');if(args.name==='q')return;
 return {args,conditions};
}
export async function provisionMenu(client,io){
 if(typeof client.provisionCatalog!=='function'||typeof client.prepareProvision!=='function'){console.log('当前连接不支持新建/克隆，请更新并使用默认本地 bash ./fo。');return;}
 try{
  const mode=await choose([{mode:'create',label:'新建实例'},{mode:'clone',label:'克隆已有实例'}],'新建/克隆模式',r=>r.label,io);if(!mode)return;
  const selected=await provisioningArgs(client,mode.mode,io);if(!selected)return;
  const plan=await client.prepareProvision(mode.mode,selected.args);
  console.log(`即将${mode.label}；精确配置：`);console.dir(plan.configuration,{depth:6});if(plan.source){console.log('克隆源实例及复制范围：');console.dir(plan.source,{depth:5});}
  printQuote(plan.quote);if(plan.warning)console.log(plan.warning);
  if(!await io.confirm()){console.log('已取消。');return;}
  const result=await client.executeProvision(plan.id,{confirmed:true});console.log(`请求已提交：${result.instanceUuid}；请查询实例状态，提交不代表已开机或拷贝完成。`);
 }catch(error){io.showError(error);}
}
async function taskPolicy(client,io){
 const choice=await choose([{mode:'powerOn',label:'等待已有实例开机'},{mode:'create',label:'有空闲卡时新建实例'},{mode:'clone',label:'有空闲卡时克隆实例'}],'自动抢卡模式',r=>r.label,io);if(!choice)return;
 let policy={mode:choice.mode};
 if(choice.mode==='powerOn'){
  const row=await choose((await client.instances()).filter(r=>stopped.has(r.status)&&r.charge_type==='payg'),'选择等待开机实例编号',r=>`${r.name||r.uuid} (${r.uuid})`,io);if(!row)return;policy.instanceUuid=row.uuid;
 }else{
  const selected=await provisioningArgs(client,choice.mode,io,{monitor:true});if(!selected)return;
  const {machineId,...args}=selected.args;policy={...policy,...selected.conditions,...args};
  if(policy.name==='')delete policy.name;
 }
 policy.maxHourly=await number('完整费用上限（元/小时，含存储日费折算）',io,{min:Number.MIN_VALUE,integer:false});if(policy.maxHourly===undefined)return;
 policy.maxMinutes=await number('最长监控分钟数（不是租用时长）',io,{min:1,max:1440});if(policy.maxMinutes===undefined)return;
 policy.intervalSeconds=await number('检查间隔秒数（至少 10 秒）',io,{min:10,max:86400});if(policy.intervalSeconds===undefined)return;
 policy.maxAttempts=Math.min(10000,Math.max(1,Math.ceil(policy.maxMinutes*60/policy.intervalSeconds)));
 return policy;
}
async function selectedTask(client,io){return choose(await client.tasks(),'选择任务编号',r=>`${r.policy?.name||r.id} / ${r.policy?.mode||'—'} / ${r.state} / ${r.id}`,io);}
export async function resourceMenu(client,io){
 if(['prepareTask','startTask','tasks','taskInfo','cancelTask'].some(k=>typeof client[k]!=='function')){
  console.log('自动抢卡需要默认本地 bash ./fo 的后台会话。当前独立终端模式不拥有后台任务服务，请退出后运行 bash ./fo。');return;
 }
 for(;;){
  const command=await io.ask('自动抢卡操作 [1 新建任务 / 2 任务列表 / 3 查看状态 / 4 停止任务 / q 返回]：');if(command==='q')return;
  try{
   if(command==='1'){
    const policy=await taskPolicy(client,io);if(!policy)continue;
    const plan=await client.prepareTask(policy);console.log('抢卡条件与费用边界：');console.dir(plan.policy,{depth:6});if(plan.candidate){console.log('当前候选（执行前仍会重新核价）：');console.dir(plan.candidate,{depth:5});}
    console.log(`完整运行费用最多 ¥${policy.maxHourly}/小时；最多监控 ${policy.maxMinutes} 分钟、检查 ${policy.maxAttempts} 次，每 ${policy.intervalSeconds} 秒检查。每个任务仅成功提交一次。`);
    console.log('监控时长不是租用时长；抢到后不会自动关机，会继续按平台规则计费。数据盘关机后仍可能收费。');
    if(!await io.confirm()){console.log('已取消。');continue;}
    const task=await client.startTask(plan.planId,{confirmed:true});console.log(`本机后台任务已启动：${task.id}，状态 ${task.state}。关闭此菜单不停止任务；电脑和网络需保持在线。通过任务列表查看结果。`);
   }else if(command==='2'){
    const rows=await client.tasks();console.table(rows.map(r=>({任务:r.id,模式:r.policy?.mode,名称:r.policy?.name||r.policy?.instanceUuid||r.policy?.sourceInstanceUuid||'—',状态:r.state,已提交:r.submitted,错误码:r.errorCode||'—'})));console.log(`共 ${rows.length} 个本地任务。`);
   }else if(command==='3'){
    const task=await selectedTask(client,io);if(task)console.dir(await client.taskInfo(task.id),{depth:6});
   }else if(command==='4'){
    const task=await selectedTask(client,io);if(!task)continue;
    console.log(`停止任务：${task.id} (${task.state})。停止监控不取消已经提交的实例，不会自动关机或释放。`);
    if(!await io.confirm()){console.log('已取消。');continue;}
    const result=await client.cancelTask(task.id,{confirmed:true});console.log(`任务状态：${result.state}。请检查实例是否已有提交结果。`);
   }else console.log('请选择 1、2、3、4 或 q。');
  }catch(error){io.showError(error);}
 }
}
