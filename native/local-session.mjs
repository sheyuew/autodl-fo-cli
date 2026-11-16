import {spawn} from 'node:child_process';
import {createConnection} from 'node:net';
import {createHash,randomUUID} from 'node:crypto';
import {mkdir,lstat,chmod,readFile,writeFile,rename,rm} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {RemoteClient} from './remote-client.mjs';

const fail=(code,message,details={})=>Object.assign(new Error(message),{code,...details});
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const hash=value=>createHash('sha256').update(value).digest('hex').slice(0,24);
export const localHome=()=>resolve(process.env.FO_LOCAL_HOME||join(homedir(),'.config','autodl-fo-cli','local'));
function accountName(username){
 if(typeof username!=='string'||!username.trim().includes('@')||username.trim().length>200||/[\x00-\x1f\x7f]/.test(username))throw fail('CREDENTIALS_REQUIRED','请输入有效的 AutoDL 子账号');
 return username.trim();
}
export function localOrigin(){
 const url=new URL(process.env.AUTODL_WEB_ORIGIN||'https://www.autodl.com');
 if(url.origin!=='https://www.autodl.com'&&!(url.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(url.hostname)))throw fail('INVALID_ORIGIN','只允许 AutoDL 官方域名或本地测试服务');
 return url.origin;
}
export async function privateDirectory(path){
 await mkdir(path,{recursive:true,mode:0o700});const info=await lstat(path);
 if(!info.isDirectory()||info.isSymbolicLink()||(process.getuid&&info.uid!==process.getuid()))throw fail('LOCAL_STATE_INVALID','本地会话目录不安全');
 await chmod(path,0o700);
}
export async function localPaths(username,{home=localHome()}={}){
 if(process.platform==='win32')throw fail('UNSUPPORTED_PLATFORM','Windows 请在 WSL 中运行本地版本');
 username=accountName(username);home=resolve(home);const profile=join(home,'profiles',hash(username));
 // macOS limits Unix socket paths to 104 bytes, regardless of the config path.
 const socketRoot=join('/tmp',`fo-local-${process.getuid?.()??'user'}`),socketDirectory=join(socketRoot,hash(home));
 for(const directory of [home,join(home,'profiles'),profile,socketRoot,socketDirectory])await privateDirectory(directory);
 return {home,profile,username,socket:join(socketDirectory,hash(username)+'.sock')};
}
async function readAccounts(home){
 try{const value=JSON.parse(await readFile(join(home,'accounts.json'),'utf8'));
  const accounts=Array.isArray(value.accounts)?value.accounts.map(row=>({username:accountName(row.username)})):[];
  return {current:accounts.some(row=>row.username===value.current)?value.current:null,accounts};
 }catch(error){if(error.code==='ENOENT')return {current:null,accounts:[]};throw error;}
}
async function lock(path,work){
 let acquired=false;
 for(let attempt=0;attempt<400;attempt++){
  try{await mkdir(path,{mode:0o700});acquired=true;break;}
  catch(error){if(error.code!=='EEXIST')throw error;const info=await lstat(path).catch(()=>null);if(info&&Date.now()-info.mtimeMs>30000)await rm(path,{recursive:true,force:true});await pause(25);}
 }
 if(!acquired)throw fail('LOCAL_BUSY','另一个本地命令正在准备会话，请稍后重试');
 try{return await work();}finally{await rm(path,{recursive:true,force:true});}
}
async function updateAccounts(home,change){
 home=resolve(home);await privateDirectory(home);
 return lock(join(home,'.accounts-lock'),async()=>{
  const value=await readAccounts(home);change(value);const temporary=join(home,'.accounts-'+randomUUID()+'.tmp');
  await writeFile(temporary,JSON.stringify(value)+'\n',{mode:0o600});await rename(temporary,join(home,'accounts.json'));return value;
 });
}
export async function listLocalAccounts({home=localHome()}={}){return readAccounts(resolve(home));}
export async function selectLocalAccount(username,{home=localHome()}={}){
 username=accountName(username);return updateAccounts(home,value=>{if(!value.accounts.some(row=>row.username===username))value.accounts.push({username});value.current=username;});
}
function socketTransport(socket){
 return request=>new Promise((resolve,reject)=>{
  const conn=createConnection(socket);let data='',finished=false,submitted=false;
  const uncertain=()=>submitted&&request.op==='panel-transfer'?fail('TRANSFER_UNCERTAIN','提交结果未知，请先查看传输记录，避免重复提交',{retryable:false}):submitted&&['instance-execute','image-execute','panel-task'].includes(request.op)?fail('ACTION_UNCERTAIN','请求结果未知，请先刷新状态，避免重复提交',{retryable:false}):fail('NETWORK','本地会话请求中断或响应无效，请稍后重试',{retryable:true});
  const done=(error,value)=>{if(finished)return;finished=true;clearTimeout(timer);conn.destroy();error?reject(error):resolve(value);};
  const timer=setTimeout(()=>done(uncertain()),180000);conn.setEncoding('utf8');
  conn.on('connect',()=>{submitted=true;conn.end(JSON.stringify(request)+'\n');});
  conn.on('data',chunk=>{data+=chunk;if(Buffer.byteLength(data)>8*1024*1024)done(uncertain());});
  conn.on('error',error=>done(!submitted&&['ENOENT','ECONNREFUSED','ENOTSOCK'].includes(error.code)?fail('LOCAL_SESSION_CLOSED','本地登录会话已关闭，请重新登录',{retryable:true}):uncertain()));
  conn.on('end',()=>{
   let reply;try{reply=JSON.parse(data);}catch{return done(uncertain());}
   if(typeof reply?.ok!=='boolean')return done(uncertain());
   if(!reply.ok)return done(fail(reply.code||'RPC_ERROR',reply.error||'本地请求失败',reply.retryable!==undefined?{retryable:reply.retryable}:{}));
   done(null,reply.result);
  });
 });
}
async function ready(request){try{await request({op:'doctor'});return true;}catch(error){if(error.code==='LOCAL_SESSION_CLOSED')return false;throw error;}}
async function startDaemon(paths,request){
 await lock(join(paths.profile,'.start-lock'),async()=>{
  if(await ready(request))return;
  localOrigin();
  await new Promise((resolve,reject)=>{
   const child=spawn(process.execPath,[fileURLToPath(new URL('./local-session-daemon.mjs',import.meta.url)),'--home',paths.home,'--username',paths.username],{detached:true,stdio:['ignore','ignore','ignore','ipc'],env:process.env});let complete=false;
   const finish=error=>{if(complete)return;complete=true;clearTimeout(timer);child.removeAllListeners('exit');if(child.connected)child.disconnect();child.unref();if(error){child.kill();reject(error);}else resolve();};
   const timer=setTimeout(()=>finish(fail('LOCAL_START_FAILED','本地登录会话启动超时')),10000);
   child.once('error',()=>finish(fail('LOCAL_START_FAILED','无法启动本地登录会话')));
   child.once('exit',()=>finish(fail('LOCAL_START_FAILED','本地登录会话未能启动')));
   child.on('message',message=>{if(message?.ready===true)finish();else if(message?.error)finish(fail('LOCAL_START_FAILED','本地登录会话未能启动'));});
  });
 });
}
export async function connectLocal({username,start=true,home=localHome()}={}){
 home=resolve(home);username=username?accountName(username):(await readAccounts(home)).current;
 if(!username)throw fail('LOGIN_REQUIRED','尚未选择本地账号，请先登录');localOrigin();
 const paths=await localPaths(username,{home}),request=socketTransport(paths.socket);
 if(!(await ready(request))){if(!start)throw fail('LOCAL_SESSION_CLOSED','本地登录会话已关闭，请重新登录');await startDaemon(paths,request);}
 const client=new RemoteClient({request}),health=await client.restore();return {client,request,username,socket:paths.socket,health};
}
export async function loginLocal(username,password,{home=localHome()}={}){
 username=accountName(username);const context=await connectLocal({username,home});await context.client.login(username,password);
 await selectLocalAccount(username,{home});return {...context,health:{...context.health,authenticated:true,identity:context.client.identity},result:{authenticated:true,identity:context.client.identity}};
}
export async function logoutLocal({username,home=localHome()}={}){
 home=resolve(home);username=username?accountName(username):(await readAccounts(home)).current;
 if(!username)throw fail('LOGIN_REQUIRED','尚未选择本地账号');
 const paths=await localPaths(username,{home}),request=socketTransport(paths.socket);
 let acknowledged=false;
 try{await request({op:'local-shutdown'});acknowledged=true;}catch(error){if(error.code!=='LOCAL_SESSION_CLOSED')throw error;}
 // A reconnect while the acknowledged helper is closing can itself be reset.
 // Wait for its socket removal instead of sending a new RPC into shutdown.
 for(let attempt=0;acknowledged&&attempt<100;attempt++){
  const exists=await lstat(paths.socket).then(()=>true,error=>{if(error.code==='ENOENT')return false;throw error;});
  if(!exists)break;if(attempt===99)throw fail('LOCAL_BUSY','本地会话正在退出，请稍后重试');await pause(10);
 }
 const value=await updateAccounts(home,value=>{if(value.current===username)value.current=value.accounts.find(row=>row.username!==username)?.username??null;});
 return {username,loggedOut:true,current:value.current};
}
