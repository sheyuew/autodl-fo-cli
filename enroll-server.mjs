import {createServer} from 'node:net';import {chmod,unlink,readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join} from 'node:path';import {execFile} from 'node:child_process';import {promisify} from 'node:util';
import {EnrollmentStore} from './lib/enrollment.mjs';import {memberInvitation,cleanPublicKey} from './lib/provision.mjs';
const exec=promisify(execFile),socket='/run/fo-enroll/enroll.sock';
if(process.getuid?.()!==0)throw new Error('接入服务需要 root');
const store=new EnrollmentStore('/var/lib/fo-enrollment',{authorizedKeys:'/etc/fo-autodl/enrollment_keys',provision:async(record,key)=>{
  const path='/etc/fo-autodl/tenants/'+record.tenant+'.json';let c;
  try{c=JSON.parse(await readFile(path,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
  if(c&&cleanPublicKey(c.publicKey)!==key)throw new Error('该成员已开通，请管理员处理');
  if(!c){
    const dir=await mkdtemp(join(tmpdir(),'fo-enroll-'));
    try{const pub=join(dir,'member.pub');await writeFile(pub,key+'\n',{mode:0o600});await exec('/usr/bin/node',['/opt/fo-autodl/multi/admin.mjs','add',record.tenant,pub],{timeout:120000});}
    catch{throw new Error('成员开通未完成，请联系管理员核对后使用原邀请码重试');}
    finally{await rm(dir,{recursive:true,force:true});}
    c=JSON.parse(await readFile(path,'utf8'));
  }
  return memberInvitation(c,record.host,record.serverHostKey);
}});
await store.refresh();await unlink(socket).catch(e=>{if(e.code!=='ENOENT')throw e;});
const server=createServer(conn=>{
  conn.setEncoding('utf8');conn.setTimeout(150000,()=>conn.destroy());let data='',done=false;
  conn.on('data',async part=>{
    if(done)return;data+=part;if(data.length>4096){done=true;conn.end('{"ok":false,"error":"请求过大"}\n');return;}
    if(!data.includes('\n'))return;done=true;
    try{const q=JSON.parse(data.slice(0,data.indexOf('\n'))),result=await store.redeem(q.invitation,q.publicKey);conn.end(JSON.stringify({ok:true,result})+'\n');}
    catch(e){conn.end(JSON.stringify({ok:false,error:e.message})+'\n');}
  });conn.on('error',()=>{});
});
server.listen(socket,async()=>{await chmod(socket,0o660);console.log('Fo invitation service ready on private Unix socket');});
for(const sig of ['SIGTERM','SIGINT'])process.on(sig,()=>server.close(()=>process.exit(0)));
