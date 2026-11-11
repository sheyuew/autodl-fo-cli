import {mkdtemp,writeFile,rm,mkdir} from 'node:fs/promises';import {join,dirname} from 'node:path';import {tmpdir} from 'node:os';
import {spawn} from 'node:child_process';import {decodeInvite,bootstrapIdentity} from './enrollment.mjs';
import {createMemberKey,importConnection} from './client-settings.mjs';import {sshArgs} from './connection.mjs';
export async function joinInvitation(code,configPath){
  const invite=decodeInvite(code);if(invite.expiresAt<=Date.now())throw new Error('邀请码已过期，请联系管理员');
  const keyDir=join(dirname(configPath),'keys');await mkdir(keyDir,{recursive:true,mode:0o700});
  const member=await createMemberKey(join(keyDir,invite.id));
  const temp=await mkdtemp(join(tmpdir(),'fo-join-'));
  try{
    const key=join(temp,'bootstrap'),hosts=join(temp,'known_hosts');
    await writeFile(key,bootstrapIdentity(invite.seed).privateKey,{mode:0o600});
    await writeFile(hosts,(invite.port===22?invite.host:`[${invite.host}]:${invite.port}`)+' '+invite.serverHostKey+'\n',{mode:0o600});
    const args=sshArgs({host:'fo-enroll@'+invite.host,port:invite.port,identityFile:key,knownHostsFile:hosts,protocol:'multi-v1'},temp);args[args.length-1]='fo-enroll';
    const result=await new Promise((resolve,reject)=>{
      const child=spawn('ssh',args,{stdio:['pipe','pipe','pipe']});let output='';
      const timer=setTimeout(()=>{child.kill();reject(new Error('邀请码兑换超时，请用原邀请码重试'));},160000);
      child.stdout.on('data',p=>{output+=p;if(output.length>16384)child.kill();});child.stderr.resume();
      child.on('error',()=>{clearTimeout(timer);reject(new Error('无法启动 SSH，请检查 OpenSSH 是否安装'));});
      child.on('close',status=>{clearTimeout(timer);try{const r=JSON.parse(output);if(!r.ok)throw new Error(r.error);if(status)throw new Error('兑换连接中断');resolve(r.result);}catch(e){reject(new Error(output?e.message:'无法兑换邀请码，请检查网络或向管理员确认有效期'));}});
      child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify({publicKey:member.publicKey}));
    });
    if(result.host!==`fo-u-${invite.tenant}@${invite.host}`||result.port!==invite.port||result.serverHostKey!==invite.serverHostKey)throw new Error('接入服务返回的连接与邀请码不符');
    const file=join(temp,'member.connection.json');await writeFile(file,JSON.stringify(result),{mode:0o600});
    return await importConnection(file,{configPath,keyPath:member.keyPath});
  }finally{await rm(temp,{recursive:true,force:true});}
}
