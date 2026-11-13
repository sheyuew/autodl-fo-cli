import readline from 'node:readline';
import {loginSubaccount} from './login.mjs';import {WebClient} from './web-client.mjs';
import {PanelClient} from './panel-client.mjs';
import {RemoteClient,sshTransport} from './remote-client.mjs';import {readFile} from 'node:fs/promises';import {dirname,resolve,join} from 'node:path';import {homedir} from 'node:os';
import {isMain} from './is-main.mjs';
import {instanceMenu,imageMenu} from './instance-menu.mjs';
import {watchTransfers} from './transfer-watch.mjs';
function ask(prompt){return new Promise((resolve,reject)=>{
  const rl=readline.createInterface({input:process.stdin,output:process.stdout});let answered=false;
  rl.on('close',()=>{if(!answered)reject(Object.assign(new Error('输入已取消'),{code:'CANCELLED'}));});
  rl.question(prompt,value=>{answered=true;rl.close();resolve(value.trim());});
});}
function secret(prompt){
  if(!process.stdin.isTTY)throw Object.assign(new Error('请输入交互式终端；验证版不接收命令行密码'),{code:'TTY_REQUIRED'});
  return new Promise((resolve,reject)=>{
    let value='';const input=process.stdin;input.setRawMode(true);input.setEncoding('utf8');input.resume();
    const finish=(error)=>{input.removeListener('data',onData);input.setRawMode(false);input.pause();process.stdout.write('\n');error?reject(error):resolve(value);};
    const onData=chunk=>{for(const character of chunk){if(character==='\r'||character==='\n'){finish();return;}if(character==='\u0003'||character==='\u0004'){finish(Object.assign(new Error('输入已取消'),{code:'CANCELLED'}));return;}if(character==='\u007f'||character==='\b')value=Array.from(value).slice(0,-1).join('');else if(character>=' ')value+=character;}};
    input.on('data',onData);process.stdout.write(prompt);
  });
}
const recoverable=new Set(['NETWORK','RATE_LIMITED','API_ERROR','PERMISSION_DENIED','SCHEMA_CHANGED','PANEL_LOGIN_REQUIRED','PANEL_ACCESS_DENIED','PANEL_NOT_INITIALIZED','PANEL_UNAVAILABLE','INVALID_ORIGIN','DISK_REQUIRED','DISK_UNAVAILABLE','DISK_UNSUPPORTED','PATH_REQUIRED','FILE_REQUIRED','FILE_EXISTS','CONFIRMATION_REQUIRED','TRANSFER_UNCERTAIN','INSTANCE_REQUIRED','IMAGE_REQUIRED','STATE_CHANGED','QUOTE_UNAVAILABLE','PLAN_CHANGED','PLAN_EXPIRED','ACTION_UNCERTAIN','INVALID_REQUEST','UNSUPPORTED_OPERATION','TASK_REQUIRED','INVALID_LIMIT']);
function showError(error){
  if(!recoverable.has(error.code))throw error;
  console.error(`${error.code}：${error.message}`);
  if(error.retryAfterSeconds!=null)console.log(`请至少等待 ${error.retryAfterSeconds} 秒再重试。`);
}
async function panelLogin(panel){
  let password=await secret('AutoPanel 独立密码（不回显），回车跳过：');
  try{if(password){await panel.signIn(password);console.log('AutoPanel 登录成功。');}}
  finally{password=undefined;}
}
function printFiles(rows,cloud=false){
  console.table(rows.map((row,i)=>({编号:i+1,名称:cloud?row.name:row.filename,类型:row.is_dir?'目录':'文件',字节:row.is_dir?'—':(cloud?row.size:row.size_in_byte)??'—'})));
  console.log(`共 ${rows.length} 项。`);
}
function printTasks(rows){
  console.table(rows.map(row=>({文件:row.file_name||'—',方向:row.task_type===1?'上传':row.task_type===2?'下载':'—',状态:row.status||'doing',进度:row.progress?.total>0?`${(100*Number(row.progress.current)/Number(row.progress.total)).toFixed(1)}%`:'—'})));
}
async function cloudDirectory(panel,mode='browse'){
  const accounts=await panel.accounts();if(!accounts.length){console.log('没有已授权网盘，请先在 AutoPanel 网页授权。');return;}
  accounts.forEach((account,i)=>console.log(`${i+1}. ${account.type}`));
  const n=Number(await ask('选择网盘编号：'));if(!Number.isInteger(n)||n<1||n>accounts.length){console.log('网盘编号无效。');return;}
  const account=accounts[n-1];let source='resource';
  if(mode!=='browse'&&account.type!=='AutoDL_AliPan')throw Object.assign(new Error('当前上传下载仅支持阿里云盘文件'),{code:'DISK_UNSUPPORTED'});
  if(/Ali/.test(account.type)){
    const choice=await ask('选择空间 [1 资源库 / 2 备份盘]：');
    if(!['1','2'].includes(choice)){console.log('空间编号无效。');return;}source=choice==='2'?'backup':'resource';
  }
  const stack=[{path:'/'}];
  for(;;){
    const current=stack.at(-1),rows=await panel.cloudFiles({account,source,...current});
    console.log(`网盘目录：${current.path}`);printFiles(rows,true);
    const hint=mode==='upload'?'输入目录编号进入 / s 上传到此目录 / u 上级 / q 返回':mode==='download'?'输入文件编号选择 / 目录编号进入 / d 编号 下载整个目录 / u 上级 / q 返回':'输入目录编号进入 / u 上级 / q 返回';
    const choice=await ask(`目录操作 [${hint}]：`);
    if(choice==='q')return;if(choice==='u'){if(stack.length>1)stack.pop();continue;}
    if(choice==='s'&&mode==='upload')return {account,source,...current,entries:rows};
    if(mode==='download'&&/^d\s+\d+$/.test(choice)){
      const row=rows[Number(choice.split(/\s+/)[1])-1];if(row?.is_dir)return {account,source,...current,file:row};
      console.log('请选择列表中的目录编号。');continue;
    }
    const index=Number(choice)-1,row=rows[index];
    if(Number.isInteger(index)&&row&&!row.is_dir&&mode==='download')return {account,source,...current,file:row};
    if(!Number.isInteger(index)||!row?.is_dir){console.log('请选择列表中的目录编号。');continue;}
    stack.push({path:current.path.replace(/\/$/,'')+'/'+row.name,fileId:row.file_id});
  }
}
async function confirmTransfer(){
  for(;;){
    const answer=(await ask('确认提交 [yes/no]：')).toLowerCase();
    if(answer==='yes')return true;if(answer==='no'){console.log('已取消。');return false;}
    console.log('请输入 yes 或 no。');
  }
}
async function submitUpload(panel){
  const localPath=await ask('实例文件绝对路径：'),split=localPath.lastIndexOf('/'),name=localPath.slice(split+1);
  if(!localPath.startsWith('/')||!name)throw Object.assign(new Error('请输入实例上文件的绝对路径'),{code:'PATH_REQUIRED'});
  const file=(await panel.localFiles(localPath.slice(0,split)||'/')).find(row=>row.filename===name);
  if(!file)throw Object.assign(new Error('所选路径不是实例上的文件或目录'),{code:'FILE_REQUIRED'});
  const destination=await cloudDirectory(panel,'upload');if(!destination)return;
  if(destination.entries.some(row=>row.name===name))throw Object.assign(new Error('网盘目标已有同名条目，请更换目标或文件名'),{code:'FILE_EXISTS'});
  console.log(`上传：实例 ${localPath} → 阿里云盘 ${destination.source==='backup'?'备份盘':'资源库'} ${destination.path.replace(/\/$/,'')}/${name}（${file.is_dir?'递归目录，包含子文件':`${file.size_in_byte??'未知'} 字节`}）`);
  if(!await confirmTransfer())return;
  await panel.upload({account:destination.account,source:destination.source,remoteDirectory:destination.path,parentFileId:destination.fileId,localPath,isDirectory:!!file.is_dir,confirmed:true});
  console.log('已提交上传任务；输入 3 或 4 查看状态。');
}
async function submitDownload(panel){
  const selection=await cloudDirectory(panel,'download');if(!selection)return;
  const workdir=await panel.workdir();
  if((await panel.localFiles(workdir)).some(row=>row.filename===selection.file.name))throw Object.assign(new Error('实例下载目录已有同名条目，请先移动或重命名'),{code:'FILE_EXISTS'});
  console.log(`下载：阿里云盘 ${selection.source==='backup'?'备份盘':'资源库'} ${selection.path.replace(/\/$/,'')}/${selection.file.name} → 实例 ${workdir}/${selection.file.name}（${selection.file.is_dir?'递归目录，包含子文件':`${selection.file.size??'未知'} 字节`}）`);
  if(!await confirmTransfer())return;
  await panel.download({account:selection.account,source:selection.source,remoteDirectory:selection.path,parentFileId:selection.fileId,file:selection.file,allowDirectory:!!selection.file.is_dir,confirmed:true});
  console.log('已提交下载任务；输入 3 或 4 查看状态。');
}
async function browseLocal(panel){
  let path=await panel.workdir();
  for(;;){
    console.log(`实例目录：${path}`);const rows=await panel.localFiles(path);printFiles(rows);
    const choice=await ask('本地目录操作 [编号进入目录 / u 上级 / p 输入路径 / q 返回]：');
    if(choice==='q')return;
    if(choice==='p'){const next=await ask('实例目录绝对路径：');if(next.startsWith('/'))path=next;continue;}
    if(choice==='u'){path=path.replace(/\/+$/,'').split('/').slice(0,-1).join('/')||'/';continue;}
    const row=rows[Number(choice)-1];
    if(!row?.is_dir||!row.filename||row.filename.includes('/')||['.','..'].includes(row.filename)){console.log('请选择目录编号。');continue;}
    path=path.replace(/\/$/,'')+'/'+row.filename;
  }
}
async function followTransfers(panel){
  const controller=new AbortController(),stop=()=>controller.abort();process.on('SIGINT',stop);
  console.log('跟踪当前队列，每 5 秒更新；任务结束后在终端和本地桌面提醒。Ctrl+C 返回菜单。');
  try{
    const result=await watchTransfers(panel,{signal:controller.signal,onUpdate:printTasks});
    console.log(result.pending?`已停止跟踪；${result.pending} 项结果尚未确认，服务器任务继续运行。`:result.completed?`已确认 ${result.completed} 项传输结果。`:'当前没有等待或传输中的任务。');
  }finally{process.removeListener('SIGINT',stop);}
}
async function cancelTransfer(panel){
  const history=await panel.taskHistory(100),rows=[...history.task_doing,...history.task_pre];
  if(!rows.length){console.log('当前没有可取消的传输任务。');return;}
  console.table(rows.map((r,i)=>({编号:i+1,任务:r.task_id,文件:r.file_name,状态:r.status||'等待'})));
  const row=rows[Number(await ask('选择取消任务编号：'))-1];if(!row)return;
  console.log(`取消传输：${row.file_name||row.task_id}`);if(!await confirmTransfer())return;
  await panel.cancelTask(row.task_id,{confirmed:true});console.log('已提交取消请求，请刷新传输队列。');
}
async function panelMenu(client){
  const rows=(await client.instances()).filter(row=>row.status==='running'&&row.has_auto_panel);
  if(!rows.length){console.log('没有可访问的运行中 AutoPanel 实例。');return;}
  rows.forEach((row,i)=>console.log(`${i+1}. ${row.name||row.uuid}`));
  const n=Number(await ask('选择实例编号：'));if(!Number.isInteger(n)||n<1||n>rows.length){console.log('实例编号无效。');return;}
  const row=rows[n-1],panel=client.openPanel?await client.openPanel(row.uuid):new PanelClient({instance:row});console.log(`已选择：${row.name||row.uuid}`);
  try{await panelLogin(panel);}catch(error){showError(error);}
  for(;;){
    const command=await ask('AutoPanel 操作 [1 目录查询 / 2 网盘目录 / 3 传输队列 / 4 传输记录 / 5 上传文件或目录 / 6 下载文件或目录 / 7 跟踪并提醒 / 8 取消任务 / 9 清理成功记录 / 10 浏览实例目录 / p 重新登录 / q 返回]：');
    if(command==='q')return;
    try{
      if(command==='p')await panelLogin(panel);
      else if(command==='1'){
        const workdir=await panel.workdir(),path=await ask(`本地目录路径（回车使用 ${workdir}）：`);
        printFiles(await panel.localFiles(path||workdir));
      }else if(command==='2')await cloudDirectory(panel);
      else if(command==='3'){
        const data=await panel.activeTasks();printTasks(data.task_doing);
        console.log(`正在传输 ${data.task_doing.length} 项；累计成功 ${data.task_success??'—'} / 总计 ${data.task_total??'—'}。`);
      }else if(command==='4'){
        const data=await panel.taskHistory();printTasks([...data.task_doing,...data.task_pre,...data.task_done]);
        console.log(`返回 ${data.task_doing.length+data.task_pre.length+data.task_done.length} 条传输记录。`);
      }else if(command==='5')await submitUpload(panel);
      else if(command==='6')await submitDownload(panel);
      else if(command==='7')await followTransfers(panel);
      else if(command==='8')await cancelTransfer(panel);
      else if(command==='9'){
        console.log('清理当前 AutoPanel 已成功的传输记录；文件保留。');
        if(await confirmTransfer()){await panel.clearCompleted({confirmed:true});console.log('已提交记录清理请求。');}
      }else if(command==='10')await browseLocal(panel);
      else console.log('请选择列表中的操作，或输入 p / q。');
    }catch(error){showError(error);if(error.code==='PANEL_ACCESS_DENIED')return;}
  }
}
export async function run({remoteConfigPath}={}){
  if(!remoteConfigPath&&process.argv[2]==='--remote'&&process.argv.length<=4)remoteConfigPath=process.argv[3]||process.env.FO_CONFIG||join(homedir(),'.config','autodl-fo-cli','config.json');
  if(!remoteConfigPath&&process.argv.length>2){
    if(process.argv[2]==='--help'&&process.argv.length===3){console.log('用法：node cli.mjs 或 node cli.mjs --remote [连接配置.json]\n在终端输入子账号和密码，管理实例、镜像和库存，操作 AutoPanel 目录、网盘传输与完成提醒。执行操作前确认 yes/no，不保存密码或会话。');return;}
    throw Object.assign(new Error('验证版不接收命令行参数；请直接运行 node cli.mjs'),{code:'USAGE'});
  }
  if(!process.stdin.isTTY)throw Object.assign(new Error('请在交互式终端运行 node cli.mjs'),{code:'TTY_REQUIRED'});
  console.log('AutoDL 子账号 HTTP 终端 · 执行操作前确认 yes/no');
  let client;
  if(remoteConfigPath){
    const path=resolve(remoteConfigPath),config=JSON.parse(await readFile(path,'utf8'));
    client=new RemoteClient({request:sshTransport(config,dirname(path))});await client.restore();console.log(`HTTP 后端服务器：${config.host}`);
  }
  const baseUrl=process.env.AUTODL_WEB_ORIGIN||'https://www.autodl.com';
  if(!client?.identity){
    const username=await ask('AutoDL 子账号：');let password=await secret('密码（不回显）：');console.log('正在登录…');
    try{if(client)await client.login(username,password);else{const session=await loginSubaccount({username,password},{baseUrl});client=new WebClient({session,expectedUsername:username,baseUrl});}}finally{password=undefined;}
  }
  console.log(`当前账号：${client.identity.username}。${remoteConfigPath?'会话仅在服务器内存中，服务重启后需重新登录。':'关闭程序后会话不保留。'}`);
  for(;;){
    const command=await ask('选择操作 [1 实例列表 / 2 地区库存 / 3 GPU 型号 / 4 AutoPanel / 5 实例管理 / 6 我的镜像 / q 退出]：');
    if(command==='q')return;
    try{
    if(command==='1'){
      const rows=await client.instances();console.table(rows.map(x=>({名称:x.name||x.uuid,状态:x.status,GPU:x.snapshot_gpu_alias_name||x.gpu_name||'—',数量:x.req_gpu_amount??'—'})));console.log(`共 ${rows.length} 个实例。`);
    }else if(command==='2'){
      const rows=(await client.regions()).filter(r=>r.visible==='all'&&r.used_for==='all');
      rows.forEach((r,i)=>console.log(`${i+1}. ${r.region_name} (${r.region_sign})`));
      const n=Number(await ask('选择地区编号：'));if(!Number.isInteger(n)||n<1||n>rows.length){console.log('地区编号无效。');continue;}
      const region=rows[n-1],machines=await client.machines({regionSigns:[region.region_sign],idle:1}),groups=new Map();
      for(const machine of machines){const name=machine.gpu_name||'未知型号';groups.set(name,(groups.get(name)||0)+1);}
      console.table([...groups].map(([GPU,主机数])=>({GPU,有空闲卡的主机数:主机数})));console.log(`${region.region_name} 当前返回 ${machines.length} 台有空闲卡的主机；主机数量不等于空闲显卡数量。`);
    }else if(command==='3'){
      console.table((await client.gpuTypes()).filter(x=>x.chip_corp!=='cpu').map(x=>({型号:x.gpu_name,架构:x.cpu_arch||'—'})));
    }else if(command==='4')await panelMenu(client);
    else if(command==='5')await instanceMenu(client,{ask,confirm:confirmTransfer,showError});
    else if(command==='6')await imageMenu(client,{ask,confirm:confirmTransfer,showError});
    else console.log('请输入 1、2、3、4、5、6 或 q。');
    }catch(error){
      showError(error);
    }
  }
}
if(isMain(import.meta.url))run().catch(e=>{console.error(`${e.code||'ERROR'}：${e.code?e.message:'程序遇到未预期错误'}`);process.exitCode=e.code==='USAGE'?2:1;});
