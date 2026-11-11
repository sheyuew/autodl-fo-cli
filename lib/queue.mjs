export class WorkQueue{
  constructor(){this.tail=Promise.resolve();this.sampling=false;}
  run(fn){const next=this.tail.catch(()=>{}).then(fn);this.tail=next;return next;}
  sample(fn){
    if(this.sampling)return;
    this.sampling=true;
    return this.run(fn).finally(()=>{this.sampling=false;});
  }
}
