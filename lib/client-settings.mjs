import {access,stat,readFile,writeFile,mkdir,chmod} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join,dirname,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {localPath} from './connection.mjs';
import {cleanPublicKey} from './provision.mjs';
import {writeJSON,readJSON} from './storage.mjs';
const exec=promisify(execFile),exists=p=>access(p).then(()=>true,()=>false);
export const defaultKey=()=>join(homedir(),'.ssh','fo-autodl');
export async function clientSettings(base){
  const home=resolve(process.env.FO_CLI_HOME||join(homedir(),'.config','autodl-fo-cli'));
  const path=process.env.FO_CONFIG?resolve(process.env.FO_CONFIG):!process.env.FO_CLI_HOME&&await exists(join(base,'config.json'))?join(base,'config.json'):join(home,'config.json');
  return {path,base:dirname(path),config:await readJSON(path,null)};
}
export async function createMemberKey(keyPath=defaultKey()){
  keyPath=localPath(keyPath,process.cwd());const publicPath=keyPath+'.pub';
  const [hasPrivate,hasPublic]=await Promise.all([exists(keyPath),exists(publicPath)]);
  if(hasPrivate!==hasPublic)throw new Error('密钥文件不完整，已保留原文件。请指定其他路径，或修复现有密钥对。');
  if(!hasPrivate){
    await mkdir(dirname(keyPath),{recursive:true,mode:0o700});
    await exec('ssh-keygen',['-t','ed25519','-N','','-f',keyPath,'-C','autodl-fo-cli']);
    await chmod(keyPath,0o600);
  }
  return {keyPath,publicPath,publicKey:cleanPublicKey(await readFile(publicPath,'utf8')),reused:hasPrivate};
}
export async function importConnection(file,{configPath,keyPath=defaultKey()}={}){
  if(!configPath)throw new Error('缺少配置保存路径');
  const invite=JSON.parse(await readFile(localPath(file,process.cwd()),'utf8'));
  if(invite.kind!=='fo-cli-invite'||invite.version!==1||typeof invite.host!=='string'||!/^fo-u-(?!owner@)[a-z][a-z0-9-]{0,23}@[A-Za-z0-9.-]+$/.test(invite.host)||!Number.isInteger(invite.port)||invite.port<1||invite.port>65535)throw new Error('连接文件格式无效，请使用管理员提供的成员邀请文件');
  const hostKey=cleanPublicKey(invite.serverHostKey);
  keyPath=localPath(keyPath,process.cwd());
  if(!(await stat(keyPath)).isFile())throw new Error('SSH 私钥路径不是文件');
  const host=invite.host.split('@')[1],hostLabel=invite.port===22?host:`[${host}]:${invite.port}`;
  const knownHostsFile='hosts-'+createHash('sha256').update(hostLabel+' '+hostKey).digest('hex').slice(0,16);
  await mkdir(dirname(configPath),{recursive:true,mode:0o700});
  await writeFile(join(dirname(configPath),knownHostsFile),hostLabel+' '+hostKey+'\n',{mode:0o600});
  const config={host:invite.host,port:invite.port,identityFile:keyPath,protocol:'multi-v1',knownHostsFile};
  await writeJSON(configPath,config);return config;
}
