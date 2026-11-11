import {randomBytes,createPrivateKey,createPublicKey} from 'node:crypto';
import {mkdir,readdir,writeFile,rename,rm,chmod} from 'node:fs/promises';import {join,dirname} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {cleanPublicKey} from './provision.mjs';import {tenantRuntime} from './tenant.mjs';import {readJSON,writeJSON} from './storage.mjs';
const uint=n=>{const b=Buffer.alloc(4);b.writeUInt32BE(n);return b;};
const field=b=>{b=Buffer.from(b);return Buffer.concat([uint(b.length),b]);};
export function bootstrapIdentity(seed){
  if(typeof seed!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(seed))throw new Error('邀请码密钥格式错误');
  const raw=Buffer.from(seed,'base64url');
  const privateKey=createPrivateKey({key:Buffer.concat([Buffer.from('302e020100300506032b657004220420','hex'),raw]),format:'der',type:'pkcs8'});
  const pub=createPublicKey(privateKey).export({format:'der',type:'spki'}).subarray(-32),blob=Buffer.concat([field('ssh-ed25519'),field(pub)]);
  const check=randomBytes(4);let secret=Buffer.concat([check,check,field('ssh-ed25519'),field(pub),field(Buffer.concat([raw,pub])),field('fo-enroll')]);
  const pad=8-secret.length%8;secret=Buffer.concat([secret,Buffer.from(Array.from({length:pad},(_,i)=>i+1))]);
  const body=Buffer.concat([Buffer.from('openssh-key-v1\0'),field('none'),field('none'),field(''),uint(1),field(blob),field(secret)]).toString('base64');
  return {publicKey:'ssh-ed25519 '+blob.toString('base64'),privateKey:'-----BEGIN OPENSSH PRIVATE KEY-----\n'+body.match(/.{1,70}/g).join('\n')+'\n-----END OPENSSH PRIVATE KEY-----\n'};
}
export function decodeInvite(code){
  if(typeof code!=='string'||code.length>4096||!/^FO1-[A-Za-z0-9_-]+$/.test(code.trim()))throw new Error('邀请码格式无效，请完整粘贴管理员发来的 FO1- 开头内容');
  let v;try{v=JSON.parse(Buffer.from(code.trim().slice(4),'base64url').toString());}catch{throw new Error('邀请码格式无效');}
  if(v.v!==1||!/^[a-f0-9]{32}$/.test(v.i)||typeof v.h!=='string'||!/^[A-Za-z0-9.-]+$/.test(v.h)||!Number.isInteger(v.p)||v.p<1||v.p>65535||!Number.isSafeInteger(v.e))throw new Error('邀请码内容无效');
  tenantRuntime({id:v.t,slot:1});bootstrapIdentity(v.s);
  return {id:v.i,tenant:v.t,host:v.h,port:v.p,serverHostKey:cleanPublicKey(v.k),seed:v.s,expiresAt:v.e};
}
export class EnrollmentStore{
  constructor(dir,{provision,now=Date.now,authorizedKeys=join(dir,'authorized_keys')}={}){Object.assign(this,{dir,provision,now,authorizedKeys});}
  path(id){if(!/^[a-f0-9]{32}$/.test(id))throw new Error('邀请码不存在');return join(this.dir,id+'.json');}
  async refresh(){
    await mkdir(this.dir,{recursive:true,mode:0o700});const lines=[];
    for(const file of await readdir(this.dir))if(/^[a-f0-9]{32}\.json$/.test(file)){
      const r=await readJSON(join(this.dir,file),null);
      if(r&&!r.revoked&&r.expiresAt>this.now())lines.push(`restrict,command="/usr/bin/node /opt/fo-autodl/multi/enroll-entry.mjs ${r.id}" ${r.bootstrapPublicKey}`);
    }
    await mkdir(dirname(this.authorizedKeys),{recursive:true,mode:0o755});
    await writeFile(this.authorizedKeys+'.tmp',lines.join('\n')+'\n',{mode:0o644});await chmod(this.authorizedKeys+'.tmp',0o644);await rename(this.authorizedKeys+'.tmp',this.authorizedKeys);
  }
  async issue({tenant,host,serverHostKey,port=22,ttlMs=86400000}){
    tenantRuntime({id:tenant,slot:1});
    const id=randomBytes(16).toString('hex'),seed=randomBytes(32).toString('base64url'),expiresAt=this.now()+ttlMs;
    const code='FO1-'+Buffer.from(JSON.stringify({v:1,i:id,t:tenant,h:host,p:port,k:serverHostKey,s:seed,e:expiresAt})).toString('base64url');
    decodeInvite(code);
    if(!Number.isFinite(ttlMs)||ttlMs<=0||ttlMs>7*86400000)throw new Error('邀请码有效期必须在 7 天内');
    await mkdir(this.dir,{recursive:true,mode:0o700});
    for(const file of await readdir(this.dir))if(/^[a-f0-9]{32}\.json$/.test(file)){
      const old=await readJSON(join(this.dir,file),null);if(old?.tenant===tenant&&!old.claimKey){old.revoked=true;await writeJSON(join(this.dir,file),old);}
    }
    await writeJSON(this.path(id),{id,tenant,host,port,serverHostKey:cleanPublicKey(serverHostKey),expiresAt,bootstrapPublicKey:bootstrapIdentity(seed).publicKey});
    await this.refresh();return code;
  }
  async revoke(id){const path=this.path(id),r=await readJSON(path,null);if(!r)throw new Error('邀请码不存在');r.revoked=true;await writeJSON(path,r);await this.refresh();}
  async redeem(id,publicKey){
    const path=this.path(id);publicKey=cleanPublicKey(publicKey);const lock=path+'.lock';
    let locked=false;for(let n=0;n<300;n++){try{await mkdir(lock);locked=true;break;}catch(e){if(e.code!=='EEXIST')throw e;await delay(100);}}
    if(!locked)throw new Error('邀请码正在兑换，请稍后重试');
    try{
      const r=await readJSON(path,null);if(!r)throw new Error('邀请码不存在');
      if(r.revoked)throw new Error('邀请码已撤销');if(r.expiresAt<=this.now())throw new Error('邀请码已过期，请向管理员领取新的邀请码');
      if(r.claimKey&&r.claimKey!==publicKey)throw new Error('邀请码已绑定另一台电脑，不能重复使用');
      if(r.result)return r.result;
      r.claimKey=publicKey;await writeJSON(path,r);
      if(!this.provision)throw new Error('未配置成员开通服务');
      r.result=await this.provision(r,publicKey);r.redeemedAt=this.now();await writeJSON(path,r);return r.result;
    }finally{await rm(lock,{recursive:true,force:true});}
  }
}
