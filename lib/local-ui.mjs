import {spawn} from 'node:child_process';import {createServer,connect} from 'node:net';
import {setTimeout as delay} from 'node:timers/promises';import {sshArgs} from './connection.mjs';
function command(file,args){return new Promise((resolve,reject)=>{const p=spawn(file,args,{stdio:'ignore'});p.on('error',reject);p.on('exit',code=>code===0?resolve():reject(new Error(`${file} 退出 ${code}`)));});}
export async function desktopNotification(title,message){
  message=String(message).slice(0,1000);
  if(process.platform==='darwin')return command('osascript',['-e','on run argv\ndisplay notification (item 2 of argv) with title (item 1 of argv)\nend run',title,message]);
  if(process.platform==='linux')return command('notify-send',['--',title,message]);
  throw new Error('当前系统未配置桌面通知，可查看终端和 fo notifications');
}
export function eventText(event){
  const title={success:'抢卡成功',cancelled:'任务已取消',failure:'任务失败',attention:'监控需要处理'}[event.kind]||'任务状态变化';
  return `[${new Date(event.at).toLocaleString()}] ${title} · ${event.taskName}${event.instanceUuid?' · 实例 '+event.instanceUuid:''}\n${event.message}`;
}
export async function openViewer(config,base,viewer){
  const local=createServer();await new Promise(r=>local.listen(0,'127.0.0.1',r));
  const port=local.address().port;await new Promise(r=>local.close(r));
  const child=spawn('ssh',sshArgs(config,base,{tunnel:{localPort:port,remotePort:viewer.port}}),{stdio:['ignore','ignore','pipe']});
  let error='',exited=false;child.stderr.on('data',b=>error+=b);child.on('error',e=>{error=e.message;exited=true;});child.on('exit',()=>{exited=true;});
  const stop=()=>child.kill('SIGTERM');process.once('SIGINT',stop);process.once('SIGTERM',stop);
  try{
    let ready=false;
    for(let i=0;i<80&&!exited;i++){
      ready=await new Promise(r=>{const s=connect({host:'127.0.0.1',port});s.once('connect',()=>{s.destroy();r(true);});s.once('error',()=>r(false));});
      if(ready)break;await delay(250);
    }
    if(!ready)throw new Error(error||'建立浏览器隧道超时');
    const url=`http://127.0.0.1:${port}/vnc.html?autoconnect=1&resize=scale#password=${encodeURIComponent(viewer.password)}`;
    try{await command(process.platform==='darwin'?'open':'xdg-open',[url]);}
    catch{console.log(`请在本机浏览器打开 http://127.0.0.1:${port}/vnc.html，再输入本次查看密码：${viewer.password}`);}
    console.log(`已打开独立浏览器：${viewer.tenant}。保持此终端以操作页面；Ctrl+C 关闭查看连接，服务器任务继续运行。`);
    if(!exited)await new Promise(r=>child.once('exit',r));
  }finally{stop();process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);}
}
