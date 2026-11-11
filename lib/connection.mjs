import {homedir} from 'node:os';import {resolve} from 'node:path';
export function localPath(value,base){
  if(typeof value!=='string'||!value)throw new Error('本地文件路径无效');
  return value.startsWith('~/')?resolve(homedir(),value.slice(2)):resolve(base,value);
}
export function sshArgs(config,base,{tunnel}={}){
  if(!/^[a-zA-Z0-9_.-]+@[a-zA-Z0-9_.-]+$/.test(config.host)||!Number.isInteger(config.port)||config.port<1||config.port>65535)throw new Error('SSH 配置无效');
  if(config.protocol&&config.protocol!=='multi-v1')throw new Error('不支持的连接协议');
  const args=['-i',localPath(config.identityFile,base),'-p',String(config.port),'-o','IdentitiesOnly=yes','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','ConnectTimeout=10','-o','ServerAliveInterval=10','-o','ServerAliveCountMax=3'];
  if(config.knownHostsFile){
    const path=localPath(config.knownHostsFile,base);
    if(/[\r\n]/.test(path))throw new Error('服务器公钥文件路径无效');
    const value=/[\s"\\]/.test(path)?'"'+path.replace(/\\/g,'\\\\').replace(/"/g,'\\"')+'"':path;
    args.push('-o','UserKnownHostsFile='+value);
  }
  if(tunnel)args.push('-N','-o','ExitOnForwardFailure=yes','-L',`127.0.0.1:${tunnel.localPort}:127.0.0.1:${tunnel.remotePort}`);
  args.push(config.host);
  if(!tunnel)args.push(config.protocol==='multi-v1'?'fo-rpc':'runuser -u fo-autodl -- node /opt/fo-autodl/cli/rpc.mjs');
  return args;
}
