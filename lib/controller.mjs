import {randomUUID,createHash} from 'node:crypto';
const digest=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
export class Controller {
  constructor(driver,journal){Object.assign(this,{driver,journal});}
  async prepare(spec){
    const resolved=await this.driver.resolve(spec),id=randomUUID();
    return this.journal.put({id,marker:`CLI-${id}`,createdAt:Date.now(),expiresAt:Date.now()+15*60*1000,
      state:'prepared',confirmation:`启动 ${id.slice(0,8)}`,resolved,hash:digest(resolved)});
  }
  async result(id){
    const p=await this.journal.get(id);
    if(['submitting','uncertain'].includes(p.state)){
      const result=await this.driver.reconcile(p);
      p.state=result.accepted?'accepted':'uncertain';p.result=result;await this.journal.put(p);
    }
    return p;
  }
  async start(id,confirmation){
    let p=await this.journal.get(id);
    if(confirmation!==p.confirmation)throw new Error('确认词不匹配，未启动');
    if(p.state!=='prepared')return this.result(id);
    if(Date.now()>p.expiresAt)throw new Error('计划已过期，请重新预览并确认');
    if(await this.driver.account()!==p.resolved.account)throw new Error('服务器登录账号已改变，未启动');
    const staged=await this.driver.stage(p);
    if(digest(staged)!==p.hash)throw new Error('当前配置与已确认配置不一致，未启动');
    p.state='submitting';await this.journal.put(p);
    try{await this.driver.clickStart(p);}catch(error){p.error=error.message;}
    try{
      const result=await this.driver.reconcile(p);
      p.state=result.accepted?'accepted':'uncertain';p.result=result;
    }catch(error){p.state='uncertain';p.error=error.message;}
    return this.journal.put(p);
  }
}
