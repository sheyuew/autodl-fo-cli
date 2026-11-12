import {createHash} from 'node:crypto';

const endpoints=Object.freeze({
  workdir:{path:'/workdir'},
  localFiles:{path:'/file',query:['abs_path']},
  accounts:{path:'/netdisk/list',login:true},
  cloudFiles:{path:'/netdisk/file',login:true,query:['fs_id','marker','abs_path','driver_id','file_id']},
  activeTasks:{path:'/netdisk/task/doing',login:true},
  taskHistory:{path:'/netdisk/task',login:true,query:['limit']},
});
const failure=(code,message,details={})=>Object.assign(new Error(message),{code,...details});
const success=code=>code==='success'||code==='Success';
function directory(path){
  if(typeof path!=='string'||!path.startsWith('/')||path.includes('\0'))throw failure('PATH_REQUIRED','请输入绝对目录路径');
  return path==='/'?'/':path.replace(/\/+$/,'')+'/';
}
function panelOrigin(instance){
  let url;
  try{url=Number(instance.jupyter_port)===0?new URL(`https://${instance.jupyter_domain}`):new URL(`http://${instance.proxy_host}:${instance.jupyter_port}`);}
  catch{throw failure('PANEL_UNAVAILABLE','实例缺少有效的 AutoPanel 访问地址');}
  const local=url.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(url.hostname);
  const official=['autodl.com','seetacloud.com'].some(domain=>url.hostname===domain||url.hostname.endsWith('.'+domain));
  if((!local&&(!official||!['http:','https:'].includes(url.protocol)))||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw failure('INVALID_ORIGIN','AutoPanel 地址必须属于 AutoDL 官方实例域名');
  return url.origin;
}

/** Each instance has an outer access token and its own independent panel login. */
export class PanelClient{
  #origin;#accessToken;#token;#timeoutMs;
  constructor({instance,timeoutMs=15000}){
    if(instance?.status!=='running'||!instance?.has_auto_panel||!instance?.jupyter_token)throw failure('PANEL_UNAVAILABLE','请选择已运行且支持 AutoPanel 的实例；程序不会自动开机');
    this.#origin=panelOrigin(instance);this.#accessToken=instance.jupyter_token;this.#timeoutMs=timeoutMs;
  }
  async #request(endpoint,{params,body}={}){
    const url=new URL('/autopanel/v1'+endpoint.path,this.#origin);
    for(const key of endpoint.query||[])if(params?.[key]!=null)url.searchParams.set(key,String(params[key]));
    const signal=AbortSignal.timeout(this.#timeoutMs);let response;
    try{response=await fetch(url,{method:body?'POST':'GET',redirect:'error',signal,headers:{Accept:'application/json',AutodlAutoPanelToken:this.#accessToken,...(this.#token?{Authorization:this.#token}:{}),...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});}
    catch{throw failure('NETWORK','AutoPanel 请求失败或超时',{retryable:true});}
    if(!response.ok){
      try{await response.body?.cancel();}catch{}
      if(response.status===401||response.status===403)throw failure('PANEL_ACCESS_DENIED','AutoPanel 访问被拒绝，请重新读取实例信息');
      if(response.status===429)throw failure('RATE_LIMITED','AutoPanel 暂时限制了请求频率，请稍后重试',{retryable:true});
      throw failure('API_ERROR','AutoPanel 服务暂时不可用',{providerCode:`HTTP${response.status}`,retryable:response.status===408||response.status>=500});
    }
    let envelope;
    try{envelope=await response.json();}catch(error){
      if(signal.aborted||error?.name==='AbortError'||error instanceof TypeError)throw failure('NETWORK','AutoPanel 响应中断或超时',{retryable:true});
      throw failure('SCHEMA_CHANGED','AutoPanel 响应不是 JSON');
    }
    if(!envelope||typeof envelope!=='object'||Array.isArray(envelope)||typeof envelope.code!=='string')throw failure('SCHEMA_CHANGED','AutoPanel 响应结构发生变化');
    const code=success(envelope.code)&&envelope.data?.code?envelope.data.code:envelope.code;
    if(code==='AutoPanelAuthFailed')throw failure('PANEL_ACCESS_DENIED','AutoPanel 实例访问凭据失效，请重新选择实例');
    if(code==='AuthFailed'){this.#token=undefined;throw failure('PANEL_LOGIN_REQUIRED','AutoPanel 独立密码不正确或登录已过期，请重新输入');}
    if(code==='NotInit'){this.#token=undefined;throw failure('PANEL_NOT_INITIALIZED','请先在 AutoPanel 网页中设置独立访问密码');}
    if(!success(code))throw failure('API_ERROR','AutoPanel 拒绝了请求',{providerCode:code.slice(0,80)});
    return envelope.data;
  }
  async signIn(password){
    this.#token=undefined;
    if(typeof password!=='string'||!password)throw failure('PANEL_LOGIN_REQUIRED','请输入 AutoPanel 独立访问密码');
    const data=await this.#request({path:'/sign_in'},{body:{password:createHash('sha1').update('autodl'+password+'AutoDL').digest('hex')}});
    if(typeof data!=='string'||!data)throw failure('SCHEMA_CHANGED','AutoPanel 登录响应缺少会话');
    this.#token=data;
  }
  async read(operation,params){
    if(!Object.hasOwn(endpoints,operation))throw failure('READ_ONLY','验证版只允许读取目录和传输状态');
    const endpoint=endpoints[operation];
    if(endpoint.login&&!this.#token)throw failure('PANEL_LOGIN_REQUIRED','请先输入 AutoPanel 独立访问密码');
    return this.#request(endpoint,{params});
  }
  async workdir(){
    const data=await this.read('workdir');if(typeof data!=='string'||!data.startsWith('/'))throw failure('SCHEMA_CHANGED','AutoPanel 工作目录结构发生变化');return data;
  }
  async localFiles(path){
    const data=await this.read('localFiles',{abs_path:directory(path)});if(!Array.isArray(data))throw failure('SCHEMA_CHANGED','AutoPanel 本地目录结构发生变化');return data;
  }
  async accounts(){
    const data=await this.read('accounts');if(data==null)return [];if(!Array.isArray(data))throw failure('SCHEMA_CHANGED','AutoPanel 网盘账号结构发生变化');return data;
  }
  async cloudFiles({account,path='/',fileId,source='resource'}){
    if(!account?.fs_id||typeof account.type!=='string')throw failure('DISK_REQUIRED','请先选择已授权网盘');
    const params={fs_id:account.fs_id,marker:''};
    if(/Baidu|S3/.test(account.type))params.abs_path=directory(path);
    else if(/Quark/.test(account.type)){
      if(path!=='/'&&!fileId)throw failure('PATH_REQUIRED','此网盘需要目录的文件 ID');params.file_id=path==='/'?'0':fileId;
    }else if(/Ali/.test(account.type)){
      const info=account.user_info||{};params.driver_id=source==='backup'?info.default_drive_id:info.resource_drive_id;
      if(!params.driver_id)throw failure('DISK_UNAVAILABLE','该网盘空间未授权，请选择其他空间');
      if(path!=='/'&&!fileId)throw failure('PATH_REQUIRED','此网盘需要目录的文件 ID');params.file_id=path==='/'?'/':fileId;
    }else throw failure('DISK_UNSUPPORTED','验证版暂未支持此网盘目录类型');
    const rows=[],seen=new Set();
    for(let page=0;page<100;page++){
      const data=await this.read('cloudFiles',params);
      if(!Array.isArray(data?.list?.List))throw failure('SCHEMA_CHANGED','AutoPanel 网盘目录结构发生变化');
      rows.push(...data.list.List);
      if(!data.next_marker)return rows;
      if(typeof data.next_marker!=='string'||seen.has(data.next_marker))throw failure('SCHEMA_CHANGED','AutoPanel 网盘目录重复分页');
      seen.add(data.next_marker);params.marker=data.next_marker;
    }
    throw failure('SCHEMA_CHANGED','AutoPanel 网盘目录超过验证版分页上限');
  }
  async activeTasks(){
    const data=await this.read('activeTasks');if(!Array.isArray(data?.task_doing))throw failure('SCHEMA_CHANGED','AutoPanel 传输队列结构发生变化');return data;
  }
  async taskHistory(limit=10){
    if(!Number.isInteger(limit)||limit<1||limit>100)throw failure('INVALID_LIMIT','传输记录数量需为 1 至 100');
    const data=await this.read('taskHistory',{limit});
    if(!Array.isArray(data?.task_pre)||!Array.isArray(data?.task_doing)||!Array.isArray(data?.task_done))throw failure('SCHEMA_CHANGED','AutoPanel 传输记录结构发生变化');return data;
  }
  #transferDrive(account,source,confirmed){
    if(confirmed!==true)throw failure('CONFIRMATION_REQUIRED','请核对传输方向和路径后确认提交');
    if(!this.#token)throw failure('PANEL_LOGIN_REQUIRED','请先输入 AutoPanel 独立访问密码');
    if(account?.type!=='AutoDL_AliPan')throw failure('DISK_UNSUPPORTED','当前传输验证仅支持阿里云盘文件');
    if(!account.fs_id||!['resource','backup'].includes(source))throw failure('DISK_REQUIRED','请选择网盘及空间');
    const drive=source==='backup'?account.user_info?.default_drive_id:account.user_info?.resource_drive_id;
    if(!drive)throw failure('DISK_UNAVAILABLE','该网盘空间未授权');return drive;
  }
  async #submitTransfer(path,body){
    let data;
    try{data=await this.#request({path},{body});}
    catch(error){
      // A lost acknowledgement can still leave a live server-side task.
      if(error.code==='NETWORK'||error.code==='SCHEMA_CHANGED'||error.retryable&&error.code==='API_ERROR')throw failure('TRANSFER_UNCERTAIN','提交结果未知，请先查看传输记录，避免重复提交',{retryable:false});
      throw error;
    }
    const id=typeof data==='string'?data:data?.task_id;
    return {accepted:true,...(typeof id==='string'&&id?{taskId:id}:{})};
  }
  async upload({account,localPath,remoteDirectory='/',parentFileId,source='resource',confirmed=false}){
    const drive=this.#transferDrive(account,source,confirmed);
    if(typeof localPath!=='string'||!localPath.startsWith('/')||localPath.endsWith('/')||localPath.includes('\0')||localPath.split('/').some(p=>p==='.'||p==='..'))throw failure('PATH_REQUIRED','请输入实例上文件的绝对路径');
    const destination=directory(remoteDirectory);
    if(destination!=='/'&&!parentFileId)throw failure('PATH_REQUIRED','上传到子目录需要所选目录的文件 ID');
    return this.#submitTransfer('/netdisk/upload',{dst_path:destination,fsid:account.fs_id,src_path:localPath,file_id:parentFileId||'/',is_dir:false,drive_id:drive});
  }
  async download({account,file,remoteDirectory='/',source='resource',confirmed=false}){
    const drive=this.#transferDrive(account,source,confirmed);
    if(file?.is_dir||typeof file?.name!=='string'||!file.name||['.','..'].includes(file.name)||file.name.includes('/')||file.name.includes('\0')||!file.file_id||!Number.isFinite(file.size)||file.size<0)throw failure('FILE_REQUIRED','请选择网盘中的一个文件');
    return this.#submitTransfer('/netdisk/download',{dst_path:'',fsid:account.fs_id,src_path:directory(remoteDirectory)+file.name,file_id:file.file_id,is_dir:false,download_url:file.download_url||'',file_size:file.size,drive_id:drive});
  }
}
