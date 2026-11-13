import {setTimeout as sleep} from 'node:timers/promises';
import {desktopNotification} from '../lib/local-ui.mjs';
const endings={success:'完成',error:'失败',failed:'失败',cancel:'已取消',cancelled:'已取消'};
export async function watchTransfers(panel,{intervalMs=5000,signal,onUpdate=()=>{},onResult=console.log,notify=desktopNotification}={}){
 const pending=new Map();let initialized=false,completed=0;
 while(!signal?.aborted){
  const data=await panel.taskHistory(100),active=[...data.task_pre,...data.task_doing],all=[...active,...data.task_done];
  if(!initialized){
   for(const task of active){if(task.task_id==null)throw Object.assign(new Error('传输队列缺少任务 ID，无法追踪完成状态'),{code:'SCHEMA_CHANGED'});pending.set(String(task.task_id),task);}
   initialized=true;if(!pending.size)return {completed:0,pending:0};
  }
  onUpdate(all.filter(t=>pending.has(String(t.task_id))));
  for(const task of all){
   const key=String(task.task_id);if(!pending.has(key)||!Object.hasOwn(endings,task.status))continue;
   pending.delete(key);completed++;const message=`${task.file_name||key}：${endings[task.status]}`;
   onResult(message);try{await notify('AutoDL 传输结果',message);}catch{onResult('桌面提醒未发送，请查看终端传输结果。');}
  }
  if(!pending.size)break;
  try{await sleep(intervalMs,undefined,{signal});}catch(error){if(error.name!=='AbortError')throw error;}
 }
 return {completed,pending:pending.size};
}
