export class PipeCDP {
  constructor(output,input,timeout=45000){
    this.output=output;this.timeout=timeout;this.id=0;this.pending=new Map();this.listeners=new Map();let buffer='';
    input.setEncoding('utf8');input.on('data',data=>{
      buffer+=data;let n;
      while((n=buffer.indexOf('\0'))>=0){const line=buffer.slice(0,n);buffer=buffer.slice(n+1);if(!line)continue;
        const msg=JSON.parse(line),p=this.pending.get(msg.id);
        if(!p){for(const fn of this.listeners.get(msg.method)||[])fn(msg);continue;}
        clearTimeout(p.timer);this.pending.delete(msg.id);msg.error?p.reject(new Error(msg.error.message)):p.resolve(msg.result);
      }
    });
    const closed=()=>{for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(new Error('Chrome 控制连接已关闭'));}this.pending.clear();};
    input.on('end',closed);input.on('error',closed);output.on('error',closed);
  }
  on(method,fn){const set=this.listeners.get(method)||new Set();this.listeners.set(method,set);set.add(fn);return ()=>set.delete(fn);}
  call(method,params={},sessionId){
    const id=++this.id;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error(`Chrome 操作超时：${method}`));},this.timeout);
      this.pending.set(id,{resolve,reject,timer});
      this.output.write(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})})+'\0');
    });
  }
  async evaluate(sessionId,expression){
    const r=await this.call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true},sessionId);
    if(r.exceptionDetails)throw new Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);
    return r.result?.value;
  }
}
