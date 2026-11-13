export async function instanceMenu(client,{ask,confirm,showError}){
 const rows=await client.instances();if(!rows.length){console.log('当前账号没有实例。');return;}
 console.table(rows.map((r,i)=>({编号:i+1,名称:r.name||r.uuid,状态:r.status,GPU:r.snapshot_gpu_alias_name||r.gpu_name||'—',数量:r.req_gpu_amount??'—'})));
 const index=Number(await ask('选择管理实例编号（q 返回）：'))-1,row=rows[index];if(!Number.isInteger(index)||!row)return;
 const uuid=row.uuid;console.log(`管理实例：${row.name||uuid} (${uuid})`);
 for(;;){
  const choice=await ask('实例操作 [1 详情 / 2 连接信息 / 3 监控 / 4 开机 / 5 关机 / 6 重启 / 7 定时关机 / 8 取消定时 / 9 重命名 / 10 保存镜像 / 11 释放 / q 返回]：');
  if(choice==='q')return;
  try{
   if(choice==='1'){console.dir(await client.instanceInfo(uuid),{depth:5});continue;}
   if(choice==='2'){
    console.table(await client.connection(uuid));
    if((await ask('显示 SSH 登录密码？[yes/no]：')).toLowerCase()==='yes')console.table(await client.connection(uuid,{includeSecrets:true,confirmed:true}));
    continue;
   }
   if(choice==='3'){console.dir(await client.monitor(uuid),{depth:6});continue;}
   const actions={'4':'powerOn','5':'powerOff','6':'restart','7':'timedShutdown','8':'cancelShutdown','9':'rename','10':'saveImage','11':'release'},action=actions[choice];
   if(!action){console.log('请选择列表中的操作。');continue;}
   const args={};if(action==='rename')args.name=await ask('实例新名称：');
   if(action==='saveImage')args.name=await ask('系统盘镜像名称：');
   if(action==='timedShutdown')args.shutdownAt=await ask('关机时间（北京时间 YYYY-MM-DD HH:mm）：');
   const plan=await client.prepareInstance(action,uuid,args);
   console.log(`${plan.label}：${plan.name} (${plan.instanceUuid})；当前状态 ${plan.status}`);
   if(plan.body.instance_name)console.log(`新名称：${plan.body.instance_name}`);
   if(plan.body.image_name)console.log(`镜像名称：${plan.body.image_name}`);
   if(plan.body.shutdown_at)console.log(`关机时间：${plan.body.shutdown_at}（北京时间）`);
   if(plan.quote){
    const q=plan.quote;console.log(`计算费用：¥${q.computeHourly.toFixed(3)}/小时；存储费用：¥${q.storageDaily.toFixed(3)}/天${q.storagePrepaid?'（已预付的存储按现有套餐）':''}`);
    console.log(`运行总计折合：¥${q.totalHourly.toFixed(3)}/小时。存储按平台原计费周期结算，关机后仍可能收费。`);
   }
   if(plan.warning)console.log(plan.warning);
   if(!await confirm())continue;
   await client.executeInstance(plan.id,{confirmed:true});console.log(`${plan.label}请求已提交；实际结果请通过详情、监控或镜像列表确认。`);
  }catch(error){showError(error);}
 }
}
export async function imageMenu(client,{ask,confirm,showError}){
 for(;;){
  const rows=await client.images();console.table(rows.map((r,i)=>({编号:i+1,名称:r.name,状态:r.status,字节:r.image_size,创建时间:r.created_at,镜像ID:r.image_uuid})));console.log(`共 ${rows.length} 个镜像。`);
  const choice=await ask('镜像操作 [编号管理 / r 刷新 / q 返回]：');if(choice==='q')return;if(choice==='r')continue;
  const row=rows[Number(choice)-1];if(!row)continue;
  try{
   const selection=await ask('所选镜像 [1 重命名 / 2 删除或移除 / q 返回]：');
   if(!['1','2'].includes(selection))continue;
   const action=selection==='1'?'rename':'delete',args=action==='rename'?{name:await ask('镜像新名称：')}:{};
   const plan=await client.prepareImage(action,row.image_uuid,args);
   console.log(`${plan.label}：${plan.name} (${plan.imageUuid})`);if(plan.body.image_name)console.log(`新名称：${plan.body.image_name}`);if(plan.warning)console.log(plan.warning);
   if(!await confirm())continue;
   await client.executeImage(plan.id,{confirmed:true});console.log('镜像操作已提交，正在刷新列表。');
  }catch(error){showError(error);}
 }
}
