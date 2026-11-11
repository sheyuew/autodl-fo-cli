#!/usr/bin/env node
import {spawn} from 'node:child_process';import {readFile} from 'node:fs/promises';import {fileURLToPath} from 'node:url';
import {dirname,join} from 'node:path';import {setTimeout as delay} from 'node:timers/promises';
import {createInterface} from 'node:readline/promises';import {confirmAndStart} from './lib/wizard.mjs';import {describePlan} from './lib/spec.mjs';
import {sshArgs} from './lib/connection.mjs';import {readJSON,writeJSON} from './lib/storage.mjs';
import {desktopNotification,eventText,openViewer} from './lib/local-ui.mjs';
import {clientSettings,createMemberKey,importConnection,defaultKey} from './lib/client-settings.mjs';
import {Writable} from 'node:stream';import {Accounts} from './lib/accounts.mjs';import {joinInvitation} from './lib/join.mjs';
const base=dirname(fileURLToPath(import.meta.url));let config,connectionBase=base,configPath,stateBase=base;
function rpc(request){return new Promise((resolve,reject)=>{
  const child=spawn('ssh',sshArgs(config,connectionBase),{stdio:['pipe','pipe','pipe']});
  let output='',err='';child.stdout.setEncoding('utf8');child.stdout.on('data',d=>output+=d);child.stderr.on('data',d=>err+=d);
  child.on('error',reject);child.on('close',code=>{if(code)return reject(new Error(err.trim()||`SSH 退出 ${code}`));try{const reply=JSON.parse(output);reply.ok?resolve(reply.result):reject(new Error(reply.error));}catch(e){reject(e);}});
  child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify(request)+'\n');
});}
const catalog=(query,args={})=>rpc({op:'catalog',query,args});
let rl;
const terminal=()=>{if(!process.stdin.isTTY||!process.stdout.isTTY)throw new Error('交互选择和启动确认必须在真实终端运行；可用 fo plan 文件.json 只预览。');rl??=createInterface({input:process.stdin,output:process.stdout});return rl;};
const ask=q=>terminal().question(q);
async function secret(label){
  if(!process.stdin.isTTY||!process.stdout.isTTY)throw new Error('密码和邀请码必须在真实终端输入');
  rl?.close();rl=null;
  const hidden=createInterface({input:process.stdin,output:new Writable({write(chunk,encoding,callback){callback();}}),terminal:true});
  process.stdout.write(label);
  try{return await hidden.question('');}finally{hidden.close();process.stdout.write('\n');}
}
async function joinAccount(){
  const accounts=new Accounts(configPath);
  if(config&&!(await accounts.list()).some(x=>x.config.host===config.host))await accounts.remember({account:'connection:'+config.host,username:'原连接（'+config.host+'）',config});
  let code=await secret('粘贴一次性邀请码（输入隐藏）: ');
  try{config=await joinInvitation(code.trim(),configPath);}finally{code=undefined;}
  connectionBase=stateBase=dirname(configPath);
  console.log('接入成功，密钥和连接已自动保存在本机。');await loginAccount();
}
async function loginAccount(){
  const accounts=new Accounts(configPath),current=(await accounts.list()).find(x=>x.config.host===config.host&&!x.account.startsWith('connection:'));
  const username=(await ask(`AutoDL 账号${current?' ['+current.username+']':''}: `)).trim()||current?.username;
  if(!username)throw new Error('请输入 AutoDL 登录账号');
  let password=await secret('AutoDL 密码（输入隐藏，不保存）: '),result;
  try{result=await rpc({op:'login-password',username,password});}finally{password=undefined;}
  if(result.state==='failed')throw new Error(result.message||'登录失败，请核对账号密码');
  if(result.state==='verification'){
    console.log((result.message||'平台要求额外验证')+'，将打开浏览器，完成后回终端按 Ctrl+C。');
    await openViewer(config,connectionBase,await rpc({op:'viewer'}));result=await rpc({op:'activate',username});
  }
  if(!result.account)throw new Error('未能确认 AutoDL 登录，请重试或运行 fo login-browser');
  await accounts.remember({account:result.account,username,config});console.log(`登录成功：${username}\n以后可用 fo switch 切换账号。`);
}
async function switchAccount(username){
  const accounts=new Accounts(configPath),rows=await accounts.list();
  if(!username){const [row]=await select('选择 AutoDL 账号',rows,x=>`${x.username}${x.config.host===config?.host?'（当前）':''}`);username=row.account;}
  config=await accounts.select(username);connectionBase=stateBase=dirname(configPath);console.log('已切换账号连接。运行 fo 查看该账号任务；登录过期时运行 fo login。');
}
async function select(title,rows,label,{multiple=false}={}){
  if(!rows.length)throw new Error(title+'没有可选项');console.log('\n'+title);
  rows.forEach((row,i)=>console.log(`  ${i+1}. ${label(row)}`));
  while(true){const text=(await ask(multiple?'按优先级输入序号，逗号分隔: ':'选择序号: ')).trim();
    const n=text.split(/[,，\s]+/).filter(Boolean).map(Number);
    if(n.length&&(multiple||n.length===1)&&new Set(n).size===n.length&&n.every(x=>Number.isInteger(x)&&x>=1&&x<=rows.length))return n.map(x=>rows[x-1]);
    console.log('序号无效，请重新输入。');
  }
}
async function number(label,def,{integer=true,min=0}={}){while(true){const s=(await ask(`${label} [${def}]: `)).trim(),n=s===''?def:Number(s);if(Number.isFinite(n)&&n>=min&&(!integer||Number.isInteger(n)))return n;console.log('数值无效，请重新输入。');}}
async function filters(gpus,regions,clone){
  const chosen=await select('选择 GPU 型号（输入顺序即优先级）',gpus,x=>x.name,{multiple:true});
  const gpuCount=await number(clone?'备用克隆 GPU 数量':'每实例 GPU 数量',1,{min:1});
  const minMemoryGb=await number('实例最低总内存 GB，0 不限制',0,{integer:false});
  const [mode]=await select('显卡驱动条件',[{id:'any',name:'不限制'},{id:'minimum',name:'最低版本'},{id:'exact',name:'指定版本，可多选'}],x=>x.name);
  let value='';if(mode.id!=='any'){
    const versions=await catalog('drivers',{gpus:chosen.map(x=>x.name),regions});
    value=(await select('选择驱动版本',versions,x=>x,{multiple:mode.id==='exact'})).join(',');
  }
  const minExpandGb=await number('目标主机可扩容容量至少 GB',0);
  const expandGb=await number('实际额外扩容 GB',0);
  return {gpus:chosen.map(x=>x.name),gpuCount,minMemoryGb,minExpandGb,expandGb,driver:{mode:mode.id,value},chosen};
}
async function wizard(){
  terminal();const status=await rpc({op:'status'});console.log(`服务器：${config.host}\n当前账号：${status.account}\n现有任务：${status.tasks.filter(t=>t.status==='监控中').length} 个监控中`);
  const [mode]=await select('任务模式',[{id:'existing',name:'原实例抢开机'},{id:'clone',name:'原实例优先，必要时克隆（含数据盘）'},{id:'new',name:'新建实例'}],x=>x.name);
  const spec={mode:mode.id};let regions=await catalog('regions');
  if(mode.id!=='new'){
    const status2=await rpc({op:'status'}),active=new Set(status2.tasks.filter(t=>t.status==='监控中').map(t=>t.source));
    const rows=(await catalog('instances')).filter(x=>!active.has(x.uuid));
    const selected=await select('选择源实例（已有监控任务的实例已排除）',rows,x=>`${x.name} · ${x.gpu} × ${x.count} · ${x.status} · ${x.uuid}`,{multiple:true});
    spec.instances=selected.map(x=>x.uuid);regions=regions.filter(r=>selected.some(x=>r.signs.includes(x.regionSign)));
    if(mode.id==='clone')console.log('原实例按原配置优先开机；以下筛选仅控制备用克隆。地区固定为源实例地区：'+regions.map(x=>x.name).join('、'));
  }else{
    regions=await select('选择地区（输入顺序即优先级）',regions,x=>x.name,{multiple:true});spec.regions=regions.map(x=>x.id);
  }
  if(mode.id!=='existing'){
    const gpus=await catalog('gpus',{regions,common:mode.id==='clone'}),f=await filters(gpus,regions,mode.id==='clone');
    const {chosen,...rest}=f;Object.assign(spec,rest);
    if(mode.id==='new'){
      const [type]=await select('镜像来源',[{id:'base',name:'官方基础镜像'},{id:'private',name:'我的私有镜像'}],x=>x.name);
      spec.imageType=type.id;const images=await catalog('images',{gpu:chosen[0],imageType:type.id});
      const [image]=await select('选择镜像',images,x=>`${x.name} · ${x.uuid}`);spec.image=image.uuid;
      spec.name=(await ask('任务名称 [命令行任务]: ')).trim()||'命令行任务';
    }
  }
  const plan=await rpc({op:'prepare',spec});return review(plan);
}
async function review(plan){
  console.log('\n请核对任务：\n'+describePlan(plan)+`\n计划 ID：${plan.id}\n15 分钟内有效。`);
  const result=await confirmAndStart(plan,ask,rpc);
  if(!result){console.log('已取消，未向 Fo 提交任务。');return;}
  printResult(result);
  if(result.state==='accepted'){rl?.close();rl=null;console.log('任务已交给服务器，开始等待完成提醒。Ctrl+C 可退出，服务器任务继续运行。');await watch();}
}
function printResult(p){console.log(JSON.stringify(p,null,2));if(p.state==='uncertain')console.log(`结果不明确；请运行 fo result ${p.id}，同一计划不会自动重复提交。`);}
async function watch(){
  const path=join(stateBase,'.fo-watch.json');let cursor=(await readJSON(path,{cursor:0,host:config.host}));
  if(cursor.host!==config.host)cursor={cursor:0,host:config.host};
  const abort=new AbortController(),stop=()=>abort.abort();let lastError='',desktopError=false;
  process.once('SIGINT',stop);process.once('SIGTERM',stop);
  console.log('等待服务器通知（约 15 秒刷新）；本地离线后可运行 fo notifications 查看记录。');
  try{while(!abort.signal.aborted){
    try{
      let result=await rpc({op:'notifications',after:cursor.cursor});
      if(result.cursor<cursor.cursor)result=await rpc({op:'notifications',after:0});
      if(result.truncated)console.log('部分较早通知已超出服务器保留范围，请核对 fo status。');
      for(const e of result.events){
        console.log('\n'+eventText(e));
        try{await desktopNotification(`AutoDL · ${e.tenant}`,eventText(e));}
        catch(err){if(!desktopError){console.log('桌面提醒不可用：'+err.message);desktopError=true;}}
      }
      cursor={cursor:result.cursor,host:config.host};await writeJSON(path,cursor);lastError='';
    }catch(e){if(e.message!==lastError){console.error('通知连接中断，将继续重连：'+e.message);lastError=e.message;}}
    await delay(15000,undefined,{signal:abort.signal}).catch(e=>{if(e.name!=='AbortError')throw e;});
  }}finally{process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);}
}
async function keygen(key){
  console.log('使用本机 Fo 专用 SSH 密钥。新建密钥不设口令，请保管好私钥。');
  const result=await createMemberKey(key);
  console.log(`${result.reused?'已复用原密钥':'已生成专用密钥'}。只把以下公钥发给管理员：\n\n${result.publicKey}\n\n公钥文件：${result.publicPath}\n收到管理员发回的 .connection.json 文件后，运行 fo setup 文件路径。`);
}
async function setup(file,key){
  if(!file){
    const [action]=await select('首次接入',[{id:'code',name:'输入一次性邀请码（推荐，自动配置）'},{id:'key',name:'高级：生成/查看接入公钥'},{id:'import',name:'高级：导入连接文件'}],x=>x.name);
    if(action.id==='code'){await joinAccount();return;}
    if(action.id==='key'){await keygen(key);return;}
    const pathInput=value=>value.trim().replace(/^(['"])(.*)\1$/,'$2').replace(/\\ /g,' ');
    file=pathInput(await ask('连接文件路径（可拖入终端）: '));
    key=pathInput(await ask(`本机专用私钥路径 [${defaultKey()}]: `))||defaultKey();
  }
  config=await importConnection(file,{configPath,keyPath:key});
  console.log(`已保存连接：${config.host}\n下一步运行 ./fo login，在终端输入 AutoDL 账号密码，再运行 ./fo 创建任务。`);
}
function help(){console.log('fo                打开操作菜单\nfo keygen         生成/查看接入公钥，私钥保留本机\nfo setup 文件     导入管理员提供的连接文件\nfo wizard         创建任务，最后 yes/no 确认\nfo login          在终端登录 AutoDL，密码隐藏且不保存\nfo join           输入一次性邀请码，自动接入并登录\nfo accounts       查看已保存的 AutoDL 账号\nfo switch         选择并切换 AutoDL 账号\nfo login-browser  浏览器登录备用方式\nfo status         查看任务\nfo watch          等待终端和本地桌面提醒\nfo notifications  查看历史通知\nfo browser        打开自己的服务器浏览器\nfo doctor         检查连接和登录\nfo notify-test    测试本地桌面通知\nfo plan 文件.json  仅生成任务预览\nfo submit 计划ID   再次确认后提交\nfo result 计划ID   查询提交结果，不重复提交\n\nkeygen/setup 可用 --key 私钥路径；无需安装 npm 依赖。\n配置文件：'+configPath);}
async function main(){
  const settings=await clientSettings(base);config=settings.config;configPath=settings.path;connectionBase=stateBase=settings.base;
  const words=process.argv.slice(2),keyAt=words.indexOf('--key'),key=keyAt>=0?words[keyAt+1]:undefined;
  if(keyAt>=0&&!key)throw new Error('--key 后需要填写私钥路径');
  if(keyAt>=0)words.splice(keyAt,2);let [cmd,arg]=words;
  while(true){
  if(['help','--help','-h'].includes(cmd)){help();return;}
  if(cmd==='keygen'){await keygen(key);return;}
  if(cmd==='setup'){await setup(arg,key);if(config&&process.stdin.isTTY){cmd=undefined;continue;}return;}
  if(cmd==='join'){await joinAccount();cmd=undefined;continue;}
  if(cmd==='accounts'){for(const row of await new Accounts(configPath).list())console.log(row.username+(row.config.host===config?.host?'（当前）':''));return;}
  if(cmd==='switch'){await switchAccount(arg);cmd=undefined;continue;}
  if(cmd==='notify-test'){await desktopNotification('AutoDL 提醒测试','这是一条本地测试消息，不代表抢卡成功。');console.log('已发送桌面提醒，请检查系统通知权限。');return;}
  if(!config){if(cmd)throw new Error('尚未配置连接。请先运行 fo join，粘贴管理员提供的一次性邀请码');await joinAccount();continue;}
  if(!cmd){
    const [action]=await select('AutoDL 远程抢卡',[{id:'wizard',name:'创建抢卡任务'},{id:'status',name:'查看任务状态'},{id:'login',name:'终端登录/重新登录 AutoDL'},{id:'watch',name:'等待完成提醒'},{id:'browser',name:'查看远程浏览器'},{id:'doctor',name:'检查连接'},{id:'notifications',name:'查看历史通知'},{id:'setup',name:'接入设置'},{id:'switch',name:'切换 AutoDL 账号'},{id:'join',name:'添加 AutoDL 账号（邀请码）'}],x=>x.name);cmd=action.id;
    // Let long-running actions receive OS signals; prompting actions reopen it.
    rl.close();rl=null;
  }
  if(cmd==='setup'){await setup();cmd=undefined;continue;}
  if(cmd==='join'){await joinAccount();cmd=undefined;continue;}
  if(cmd==='switch'){await switchAccount();cmd=undefined;continue;}
  if(cmd==='wizard')await wizard();
  else if(cmd==='status'||cmd==='doctor')console.log(JSON.stringify(await rpc({op:cmd}),null,2));
  else if(cmd==='plan'){if(!arg)throw new Error('用法：fo plan 配置.json');const plan=await rpc({op:'prepare',spec:JSON.parse(await readFile(arg,'utf8'))});console.log(describePlan(plan)+`\n计划 ID：${plan.id}\n仅预览，未提交。提交命令：fo submit ${plan.id}`);}
  else if(cmd==='submit'){if(!arg)throw new Error('用法：fo submit 计划ID');const plan=await rpc({op:'result',id:arg});if(plan.state==='prepared')await review(plan);else printResult(plan);}
  else if(cmd==='result'){if(!arg)throw new Error('用法：fo result 计划ID');printResult(await rpc({op:'result',id:arg}));}
  else if(cmd==='browser')await openViewer(config,connectionBase,await rpc({op:'viewer'}));
  else if(cmd==='login'){await loginAccount();cmd=undefined;continue;}
  else if(cmd==='login-browser'){
    console.log('将在自己的远程浏览器打开 AutoDL。登录后回到此终端按 Ctrl+C 完成登录并恢复 Fo。登录期间该环境的 Fo 执行可能暂停，任务记录会保留。');
    await openViewer(config,connectionBase,await rpc({op:'login'}));
    console.log(JSON.stringify(await rpc({op:'activate'}),null,2));
  }
  else if(cmd==='watch')await watch();
  else if(cmd==='notifications'){const result=await rpc({op:'notifications',after:0});for(const e of result.events)console.log(eventText(e)+'\n');if(!result.events.length)console.log('暂无通知。');if(result.error)console.log('当前监控提示：'+result.error);}
  else throw new Error('未知命令；运行 fo help');
  return;
  }
}
try{await main();}catch(e){console.error('错误：'+e.message);process.exitCode=1;}finally{rl?.close();}
