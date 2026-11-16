import {writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {startHttpServer} from './http-server.mjs';
import {localPaths,localOrigin} from './local-session.mjs';
import {isMain} from './is-main.mjs';
import {desktopNotification} from '../lib/local-ui.mjs';

if(isMain(import.meta.url)){
 process.umask(0o077);
 let service,timer,closing=false,paths,active=0;
 const stop=async()=>{
  if(closing)return;closing=true;clearTimeout(timer);await service?.close();
  if(paths)await rm(join(paths.profile,'helper.pid'),{force:true});
 };
 try{
  const args=process.argv.slice(2);
  if(args.length!==4||args[0]!=='--home'||args[2]!=='--username')throw new Error('Invalid local helper arguments');
  paths=await localPaths(args[3],{home:args[1]});const baseUrl=localOrigin();
  const configured=Number(process.env.FO_LOCAL_IDLE_MS),idleMs=Number.isFinite(configured)&&configured>=100?configured:30*60*1000;
  const touch=()=>{clearTimeout(timer);if(closing||active)return;timer=setTimeout(()=>{if(service?.hasActiveTasks)touch();else void stop();},idleMs);timer.unref();};
  const onRequest=()=>{active++;clearTimeout(timer);return ()=>{active--;touch();};};
  const notify=event=>desktopNotification(event.state==='completed'?'AutoDL 实例已运行':'AutoDL 任务状态',event.message);
  service=await startHttpServer({state:paths.profile,socket:paths.socket,tenantId:'local',baseUrl,logger:()=>{},onRequest,onShutdown:stop,notify});
  await writeFile(join(paths.profile,'helper.pid'),String(process.pid)+'\n',{mode:0o600});touch();
  for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>void stop());
  process.send?.({ready:true});
 }catch{
  process.send?.({error:true});await stop();process.exitCode=1;
 }
}
