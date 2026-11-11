#!/usr/bin/env node
import {execFileSync} from 'node:child_process';
import {mkdir,readFile,writeFile,readdir,access,chmod,cp,rm} from 'node:fs/promises';
import {join,dirname} from 'node:path';import {fileURLToPath} from 'node:url';
import {randomBytes} from 'node:crypto';import {tenantRuntime} from './lib/tenant.mjs';
import {EnrollmentStore,decodeInvite} from './lib/enrollment.mjs';
import {memberFiles,cleanPublicKey,memberInvitation,writePublicFile} from './lib/provision.mjs';import {writeJSON} from './lib/storage.mjs';
const base=dirname(fileURLToPath(import.meta.url)),etc='/etc/fo-autodl';
const run=(file,args,options={})=>execFileSync(file,args,{encoding:'utf8',stdio:'pipe',...options});
function serviceState(unit){try{return run('systemctl',['is-active',unit]).trim();}catch(e){if(e.status===3)return String(e.stdout).trim()||'inactive';throw e;}}
const exists=async path=>access(path).then(()=>true,()=>false);
const configPath=id=>join(etc,'tenants',id+'.json');
async function config(id){tenantRuntime({id,slot:1});return JSON.parse(await readFile(configPath(id),'utf8'));}
async function list(){return (await readdir(etc+'/tenants')).filter(x=>x.endsWith('.json')).sort().map(x=>x.slice(0,-5));}
async function keyFile(path){return cleanPublicKey(await readFile(path,'utf8'));}
async function writeConfig(c){
  const t=tenantRuntime(c),files=memberFiles(c,c.publicKey);
  await writeJSON(configPath(c.id),c);await chmod(configPath(c.id),0o644);
  await writeJSON(etc+'/users/'+t.user+'.json',{id:c.id,slot:c.slot});await chmod(etc+'/users/'+t.user+'.json',0o644);
  await writePublicFile(etc+'/env/'+c.id,Object.entries({...files.env,FO_DISPLAY:t.display,FO_STATE:t.state,FO_WEB_PORT:t.webPort,FO_VNC_PORT:t.vncPort}).map(([k,v])=>`${k}=${v}`).join('\n')+'\n');
  await writePublicFile(etc+'/keys/'+t.user,files.key);
  const sshPath='/etc/ssh/sshd_config.d/70-fo-'+c.id+'.conf';
  await writePublicFile(sshPath,files.ssh);
  try{run('/usr/sbin/sshd',['-t']);}catch(e){await rm(sshPath);throw e;}
  run('systemctl',['reload','ssh']);
}
async function add(id,pubPath){
  tenantRuntime({id,slot:1});
  if(await exists(configPath(id)))throw new Error('该代号已存在，请使用 key 命令更新公钥');
  const publicKey=await keyFile(pubPath),used=[];
  for(const name of await list())used.push((await config(name)).slot);
  const slot=Array.from({length:50},(_,i)=>i+1).find(x=>!used.includes(x));
  if(!slot)throw new Error('无可用槽位');
  const c={id,slot,publicKey,createdAt:new Date().toISOString()},t=tenantRuntime(c);
  try{run('id',[t.user]);throw new Error('同名 Unix 用户已经存在，拒绝接管');}catch(e){if(e.status===undefined)throw e;}
  run('useradd',['--system','--user-group','--create-home','--home-dir',t.state,'--shell','/bin/sh','--password','*',t.user]);
  await chmod(t.state,0o700);
  await mkdir(t.profile,{mode:0o700});
  const secret=randomBytes(12).toString('base64url').slice(0,8);
  await writeFile(t.state+'/vnc-secret',secret,{mode:0o600});
  run('x11vnc',['-storepasswd',secret,t.state+'/vnc.passwd'],{stdio:'ignore'});
  await writeFile(t.state+'/Xauthority','',{mode:0o600});
  run('xauth',['-f',t.state+'/Xauthority','add',t.display,'.',randomBytes(16).toString('hex')]);
  run('chown',['-R',t.user+':'+t.user,t.state]);
  await writeConfig(c);
  run('systemctl',['daemon-reload']);run('systemctl',['enable','--now','fo-user@'+id+'.target']);
  console.log(`已创建 ${id}，独立用户 ${t.user}，浏览器端口 ${t.webPort}。`);
  console.log('成员运行 ./fo login 完成官方登录后，自动进入独立 Fo 任务窗口。');
}
async function invitation(id,host){
  const c=await config(id),key=await readFile('/etc/ssh/ssh_host_ed25519_key.pub','utf8');
  const value=memberInvitation(c,host,key),dest='/opt/fo-autodl/member-bundles/'+id+'.connection.json';
  await writeJSON(dest,value);console.log(dest);return value;
}
async function bundle(id,host){
  if(!host||!/^[a-zA-Z0-9.-]+$/.test(host))throw new Error('请提供服务器 IP 或域名');
  const c=await config(id),t=tenantRuntime(c),dest='/opt/fo-autodl/member-bundles/'+id;
  await rm(dest,{recursive:true,force:true});await mkdir(dest+'/lib',{recursive:true,mode:0o700});
  for(const name of ['fo','cli.mjs','README.md'])await cp(join(base,name),join(dest,name));
  for(const name of ['THIRD_PARTY.md','开始使用.command'])if(await exists(join(base,name)))await cp(join(base,name),join(dest,name));
  if(await exists(base+'/docs'))await cp(base+'/docs',dest+'/docs',{recursive:true});
  for(const name of await readdir(base+'/lib'))if(name.endsWith('.mjs'))await cp(join(base,'lib',name),join(dest,'lib',name));
  await chmod(dest+'/fo',0o755);
  await writeJSON(dest+'/config.json',{host:t.user+'@'+host,port:22,identityFile:'~/.ssh/fo-autodl',protocol:'multi-v1',knownHostsFile:'known_hosts'});
  const hostKey=(await readFile('/etc/ssh/ssh_host_ed25519_key.pub','utf8')).trim().split(/\s+/).slice(0,2).join(' ');
  await writeFile(dest+'/known_hosts',host+' '+hostKey+'\n');
  await writeFile(dest+'/开始使用.txt',`这是 ${id} 的专用客户端。\n1. 本地安装 Node.js 18+ 和 OpenSSH。\n2. 将自己的私钥保存在 ~/.ssh/fo-autodl，或修改 config.json 的 identityFile。不要使用他人的私钥。\n3. chmod 600 ~/.ssh/fo-autodl\n4. ./fo login，在自己的远程浏览器登录 AutoDL；登录后回终端 Ctrl+C 完成并恢复 Fo。\n5. ./fo doctor 确认账号，然后 ./fo 创建任务，最后输入 yes/no。\n6. ./fo watch 等待终端/桌面提醒；./fo notifications 查看离线期间记录。\n\n此包不含私钥、AutoDL 密码或登录状态。首次成功读取后该环境绑定账号，换账号请联系管理员。\nFo 当前不支持价格上限；请在确认前核对配置。\n`);
  run('tar',['-czf',dest+'.tar.gz','-C',dirname(dest),id]);await chmod(dest+'.tar.gz',0o600);
  console.log(dest+'.tar.gz');
}
if(process.getuid?.()!==0)throw new Error('管理员命令必须在服务器以 root 运行');
let locked=false;
try{
  for(const dir of ['tenants','users','env','keys'])await mkdir(etc+'/'+dir,{recursive:true,mode:0o755});
  await mkdir('/var/lib/fo-tenants',{recursive:true,mode:0o711});
  await mkdir('/run/fo-multi-admin.lock');locked=true;
  const [cmd,id,arg]=process.argv.slice(2);
  if(cmd==='add')await add(id,arg);
  else if(cmd==='key'){const c=await config(id);c.publicKey=await keyFile(arg);await writeConfig(c);console.log('公钥已更新');}
  else if(cmd==='bundle')await bundle(id,arg);
  else if(cmd==='invite')await invitation(id,arg);
  else if(cmd==='invite-code'){
    tenantRuntime({id,slot:1});if(await exists(configPath(id)))throw new Error('该代号已存在，请为另一个 AutoDL 账号使用新代号');
    const hostKey=await readFile('/etc/ssh/ssh_host_ed25519_key.pub','utf8');
    const store=new EnrollmentStore('/var/lib/fo-enrollment',{authorizedKeys:etc+'/enrollment_keys'});
    const code=await store.issue({tenant:id,host:arg,serverHostKey:hostKey});
    console.log('将以下完整邀请码私下发给该成员；24 小时有效，只能绑定一台电脑。');console.log(code);
    console.log('撤销命令：fo-admin revoke-code '+decodeInvite(code).id);
  }
  else if(cmd==='revoke-code')await new EnrollmentStore('/var/lib/fo-enrollment',{authorizedKeys:etc+'/enrollment_keys'}).revoke(id);
  else if(cmd==='list'){for(const name of await list()){const t=tenantRuntime(await config(name));console.log(JSON.stringify({id:name,user:t.user,webPort:t.webPort,active:serviceState('fo-user@'+name+'.target')}));}}
  else if(cmd==='disable'){const c=await config(id);await rm(etc+'/keys/'+tenantRuntime(c).user,{force:true});run('systemctl',['disable','--now','fo-user@'+id+'.target']);console.log('已撤销 SSH 并停止该环境，账号资料保留。');}
  else console.log('fo-admin invite-code 新代号 服务器地址\nfo-admin revoke-code 邀请ID\nfo-admin add 代号 公钥文件\nfo-admin invite 代号 服务器地址\nfo-admin key 代号 新公钥文件\nfo-admin bundle 代号 服务器地址\nfo-admin list\nfo-admin disable 代号');
}catch(e){console.error(e.stderr?.toString().trim()||e.message);process.exitCode=1;}
finally{if(locked)await rm('/run/fo-multi-admin.lock',{recursive:true,force:true});}
