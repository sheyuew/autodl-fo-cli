import {tenantRuntime} from './tenant.mjs';
import {writeFile,chmod} from 'node:fs/promises';
export async function writePublicFile(path,content){await writeFile(path,content,{mode:0o644});await chmod(path,0o644);}
export function memberInvitation(config,host,serverHostKey){
  if(typeof host!=='string'||!/^[A-Za-z0-9.-]+$/.test(host))throw new Error('请提供服务器 IP 或域名');
  const tenant=tenantRuntime(config);
  return {kind:'fo-cli-invite',version:1,host:tenant.user+'@'+host,port:22,serverHostKey:cleanPublicKey(serverHostKey)};
}
export function cleanPublicKey(input){
  if(typeof input!=='string'||/[\r\n]/.test(input.trim()))throw new Error('只接受单行 Ed25519 SSH 公钥');
  const match=input.trim().match(/^ssh-ed25519 ([A-Za-z0-9+/]+={0,2})(?:\s+[^\r\n]*)?$/);
  if(!match)throw new Error('请使用 ssh-keygen -t ed25519 生成公钥，不接受密钥选项或私钥');
  const b=Buffer.from(match[1],'base64');
  if(b.length!==51||b.readUInt32BE(0)!==11||b.subarray(4,15).toString()!=='ssh-ed25519'||b.readUInt32BE(15)!==32)throw new Error('Ed25519 公钥格式错误');
  return 'ssh-ed25519 '+b.toString('base64');
}
export function memberFiles(config,key){
  const t=tenantRuntime(config);
  return {key:cleanPublicKey(key)+'\n',env:{DISPLAY:t.display,XAUTHORITY:t.state+'/Xauthority',HOME:t.state,FO_TENANT_CONFIG:'/etc/fo-autodl/tenants/'+t.id+'.json',CHROME_DEVEL_SANDBOX:'/opt/fo-autodl/browser/chrome-linux64/chrome_sandbox'},ssh:`Match User ${t.user}
    AuthorizedKeysFile /etc/fo-autodl/keys/%u
    ForceCommand /usr/bin/node /opt/fo-autodl/multi/ssh-entry.mjs
    PermitTTY no
    X11Forwarding no
    AllowAgentForwarding no
    AllowTcpForwarding local
    AllowStreamLocalForwarding no
    PermitOpen 127.0.0.1:${t.webPort}
    PermitTunnel no
    PermitUserRC no
    PasswordAuthentication no
    KbdInteractiveAuthentication no
Match all
`};
}
