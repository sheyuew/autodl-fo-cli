import {join} from 'node:path';import {readJSON,writeJSON} from './storage.mjs';
const initial={initialized:false,account:null,seen:{},events:[],nextSeq:1,error:null};
const terminal={'已成功':'success','已取消':'cancelled','已失败':'failure'};
export class Notifications{
  constructor(state,tenant){this.path=join(state,'notifications.json');this.tenant=tenant;}
  async load(){return readJSON(this.path,initial);}
  add(s,event){s.events.push({seq:s.nextSeq++,tenant:this.tenant,account:s.account,at:new Date().toISOString(),...event});s.events=s.events.slice(-500);}
  async observe(snapshot){
    const s=await this.load();
    if(s.account&&s.account!==snapshot.account)throw new Error('通知账号发生变化');
    s.account=snapshot.account;s.error=null;
    const counts=new Map();
    for(const t of snapshot.tasks){
      const n=counts.get(t.name)||0;counts.set(t.name,n+1);
      const key=JSON.stringify([t.name,n]),instanceUuid=[...t.text.matchAll(/实例：([^\s]+)/g)].at(-1)?.[1]||null;
      const signature=JSON.stringify([t.status,instanceUuid]);
      if(s.initialized&&terminal[t.status]&&s.seen[key]!==signature)this.add(s,{kind:terminal[t.status],taskName:t.name,instanceUuid,message:t.text});
      s.seen[key]=signature;
    }
    s.seen=Object.fromEntries(Object.entries(s.seen).slice(-2000));s.initialized=true;
    await writeJSON(this.path,s);
  }
  async failure(message){
    const s=await this.load();
    if(s.initialized&&s.error!==message)this.add(s,{kind:'attention',taskName:'监控需要处理',instanceUuid:null,message});
    s.error=message;await writeJSON(this.path,s);
  }
  async list(after=0){
    if(!Number.isSafeInteger(after)||after<0)throw new Error('通知游标无效');
    const s=await this.load();return {tenant:this.tenant,account:s.account,events:s.events.filter(e=>e.seq>after),cursor:s.nextSeq-1,truncated:after>0&&s.events.length>0&&after<s.events[0].seq-1,error:s.error};
  }
}
