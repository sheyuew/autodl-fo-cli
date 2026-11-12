import {spawn} from 'node:child_process';import {sshArgs} from './ssh-connection.mjs';
const failure=(code,message,details={})=>Object.assign(new Error(message),{code,...details});
export function sshTransport(config,base){
  const args=sshArgs(config,base);
  return request=>new Promise((resolve,reject)=>{
    const child=spawn('ssh',args,{stdio:['pipe','pipe','pipe']});let output='',done=false;
    const uncertain=()=>request.op==='panel-transfer'?failure('TRANSFER_UNCERTAIN','提交结果未知，请先查看传输记录，避免重复提交',{retryable:false}):failure('NETWORK','服务器 SSH 连接失败或超时',{retryable:true});
    const finish=(error,value)=>{if(done)return;done=true;clearTimeout(timer);error?reject(error):resolve(value);};
    const timer=setTimeout(()=>{child.kill();finish(uncertain());},180000);
    child.stdout.setEncoding('utf8');child.stdout.on('data',chunk=>{output+=chunk;if(Buffer.byteLength(output)>8*1024*1024){child.kill();finish(uncertain());}});
    child.stderr.resume();child.on('error',()=>finish(uncertain()));child.stdin.on('error',()=>{});
    child.on('close',code=>{
      if(code)return finish(uncertain());let reply;
      try{reply=JSON.parse(output);}catch{return finish(uncertain());}
      if(!reply||typeof reply.ok!=='boolean')return finish(uncertain());
      if(!reply.ok)return finish(failure(reply.code||'RPC_ERROR',reply.error||'服务器拒绝了请求',reply.retryable!==undefined?{retryable:reply.retryable}:{}));
      finish(null,reply.result);
    });
    child.stdin.end(JSON.stringify(request)+'\n');
  });
}
export class RemoteClient{
  #request;
  constructor({request}){this.#request=request;}
  async restore(){const health=await this.#request({op:'doctor'});if(health.backend!=='native-http')throw failure('BACKEND_MISMATCH','服务器尚未切换到 HTTP 版本');if(health.authenticated)this.identity=Object.freeze(health.identity);return health;}
  async login(username,password){const result=await this.#request({op:'login-password',username,password});if(result.identity?.username!==username)throw failure('ACCOUNT_MISMATCH','服务器登录身份与输入账号不符');this.identity=Object.freeze(result.identity);}
  instances(){return this.#request({op:'instances'});}
  regions(){return this.#request({op:'regions'});}
  gpuTypes(){return this.#request({op:'gpu-types'});}
  machines(args){return this.#request({op:'machines',args});}
  async openPanel(instanceUuid){
    const {handle}=await this.#request({op:'panel-open',instanceUuid}),request=q=>this.#request({handle,...q});
    return {
      signIn:password=>request({op:'panel-login',password}),
      workdir:()=>request({op:'panel-read',query:'workdir'}),
      localFiles:path=>request({op:'panel-read',query:'localFiles',path}),
      accounts:()=>request({op:'panel-read',query:'accounts'}),
      activeTasks:()=>request({op:'panel-read',query:'activeTasks'}),
      taskHistory:()=>request({op:'panel-read',query:'taskHistory'}),
      cloudFiles:({account,path='/',fileId,source='resource'})=>request({op:'panel-cloud',diskId:account.fs_id,args:{path,fileId,source}}),
      upload:({account,localPath,remoteDirectory='/',parentFileId,source='resource',confirmed=false})=>request({op:'panel-transfer',direction:'upload',diskId:account.fs_id,localPath,remoteDirectory,parentFileId,source,confirmed}),
      download:({account,file,remoteDirectory='/',parentFileId,source='resource',confirmed=false})=>request({op:'panel-transfer',direction:'download',diskId:account.fs_id,source,remoteDirectory,parentFileId,fileId:file.file_id,fileName:file.name,confirmed}),
    };
  }
}
