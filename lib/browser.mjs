import {foPage} from './page.mjs';import {resolveSpec} from './spec.mjs';
export class BrowserDriver {
  constructor(cdp,sessionId,persist){Object.assign(this,{cdp,sessionId,persist});}
  page(op,args={}){return this.cdp.evaluate(this.sessionId,`(${foPage.toString()})(${JSON.stringify({op,args})})`);}
  account(){return this.page('account');}
  status(){return this.page('status');}
  diagnose(){return this.page('diagnose');}
  catalog(query,args={}){return this.page('catalog',{query,...args});}
  async context(spec){
    const status=await this.status(),regions=await this.catalog('regions'),rawInstances=await this.catalog('instances');
    const instances=rawInstances.map(x=>({uuid:x.uuid,name:x.name,gpu:x.gpu,count:x.count,region:regions.find(r=>r.signs.includes(x.regionSign))?.id,expandGb:x.expandGb}));
    const selected=spec.mode==='new'?regions.filter(r=>spec.regions?.includes(r.id)):regions.filter(r=>instances.some(x=>spec.instances?.includes(x.uuid)&&x.region===r.id));
    const gpus=spec.mode==='existing'?[]:await this.catalog('gpus',{regions:selected,common:spec.mode==='clone'});
    const drivers=spec.mode!=='existing'&&spec.driver?.mode!=='any'?await this.catalog('drivers',{gpus:spec.gpus,regions:selected}):[];
    const gpu=gpus.find(g=>spec.gpus?.includes(g.name));
    const images=spec.mode==='new'&&gpu?await this.catalog('images',{gpu,imageType:spec.imageType}):[];
    return {account:status.account,regions,instances,gpus,drivers,images,tasks:status.tasks,activeSources:status.tasks.filter(t=>t.status==='监控中').map(t=>t.source).filter(Boolean)};
  }
  async resolve(spec){return resolveSpec(spec,await this.context(spec));}
  async stage(plan){
    const resolved=await this.resolve(plan.resolved.spec);
    const instanceRows=await this.catalog('instances');
    await this.page('stage',{plan,instanceRows});
    this.staged={id:plan.id,instanceRows};return resolved;
  }
  async clickStart(plan){
    if(this.staged?.id!==plan.id)throw new Error('计划未填入 Fo 表单');
    await this.page('submit',{plan,instanceRows:this.staged.instanceRows});
  }
  async reconcile(plan){
    const deadline=Date.now()+8000;
    do{
      const {tasks}=await this.status();let found;
      if(plan.resolved.mode==='new')found=tasks.filter(t=>t.name.includes(`[${plan.marker}]`));
      else found=plan.resolved.instances.map(x=>{
        const matches=tasks.filter(t=>t.source===x.uuid),before=plan.resolved.beforeCounts?.[x.uuid]||0;
        return matches.length>before?matches.at(-1):null;
      }).filter(Boolean);
      if(found.length===(plan.resolved.mode==='new'?1:plan.resolved.instances.length)){await this.persist?.();return {accepted:true,tasks:found};}
      await new Promise(r=>setTimeout(r,250));
    }while(Date.now()<deadline);
    return {accepted:false,message:'提交结果不明确，请查看状态；同一计划不会自动重新提交'};
  }
}
