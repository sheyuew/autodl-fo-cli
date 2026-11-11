import {createHash,randomBytes} from 'node:crypto';import {readJSON,writeJSON} from './storage.mjs';
export const RUNNER_URL='https://www.autodl.com/__fo_cli_runner__';
const hash='593016a9c2079e3ff9e77e5cd05e45fa84b9ffae8533d246e9976b88c01f286a';
// This adapter runs inside the member's own browser. Tokens stay in that browser.
export function installGM(saved,persist){
  const clone=v=>JSON.parse(JSON.stringify(v));let state=saved,pending=Promise.resolve();
  globalThis.GM_getValue=(key,fallback)=>{
    if(key!=='autodl-helper-v1')throw new Error('不支持的 Fo 存储键');
    if(state)return clone(state);
    const value=clone(fallback);if(value.settings){value.settings.sound=false;value.settings.desktop=false;}return value;
  };
  globalThis.GM_setValue=(key,value)=>{
    if(key!=='autodl-helper-v1')throw new Error('不支持的 Fo 存储键');
    state=clone(value);const snapshot=clone(state);pending=pending.then(()=>persist(snapshot));
  };
  globalThis.__fo_flush=()=>pending;
  // Fo awaits this lock for every state mutation, including creation intents.
  // Keep the lock until the server has fsynced the state before Fo continues.
  if(typeof navigator!=='undefined'&&navigator.locks){
    const request=navigator.locks.request.bind(navigator.locks);
    navigator.locks.request=(name,...args)=>{
      const callback=args.pop();
      return request(name,...args,name==='autodl-helper-v1-state'?async(...values)=>{const result=await callback(...values);await pending;return result;}:callback);
    };
  }
  globalThis.GM_addValueChangeListener=()=>{};
  globalThis.GM_notification=()=>{};
  globalThis.GM_xmlhttpRequest=options=>queueMicrotask(()=>options.onerror?.(new Error('当前运行环境使用 fo watch 发送终端和本地桌面提醒')));
}
export class FoRuntime{
  constructor(cdp,source,statePath){
    if(createHash('sha256').update(source).digest('hex')!==hash)throw new Error('Fo 0.3.5 源码校验失败');
    if(typeof statePath!=='string'||!statePath)throw new Error('缺少独立任务存储路径');
    this.cdp=cdp;this.source=source;this.statePath=statePath;this.sessions=new Set();this.nonces=new Map();this.tail=Promise.resolve();
    cdp.on('Runtime.bindingCalled',e=>{
      if(e.params.name!=='__fo_cli_store'||!this.sessions.has(e.sessionId))return;
      let q;try{if(e.params.payload.length>1024*1024)return;q=JSON.parse(e.params.payload);}catch{return;}
      if(q?.nonce!==this.nonces.get(e.sessionId)||!Number.isSafeInteger(q.seq)||q.seq<1)return;
      const work=this.tail.catch(()=>{}).then(async()=>{
        if(q.op==='get')return readJSON(this.statePath,null);
        if(q.op!=='set'||q.value?.version!==1||!Array.isArray(q.value.tasks)||!Array.isArray(q.value.events)||!Array.isArray(q.value.logs))throw new Error('Fo 状态格式无效');
        await writeJSON(this.statePath,q.value);return null;
      });
      this.tail=work;
      const reply=(ok,value)=>cdp.call('Runtime.evaluate',{expression:`globalThis.__fo_cli_reply?.(${q.seq},${ok},${JSON.stringify(value)})`,contextId:e.params.executionContextId},e.sessionId).catch(()=>{});
      void work.then(value=>reply(true,value),err=>reply(false,err.message));
    });
    cdp.on('Fetch.requestPaused',e=>{
      if(!this.sessions.has(e.sessionId))return;
      const params=e.params;
      const action=params.request.url===RUNNER_URL?cdp.call('Fetch.fulfillRequest',{requestId:params.requestId,responseCode:200,responseHeaders:[{name:'Content-Type',value:'text/html; charset=utf-8'},{name:'Cache-Control',value:'no-store'}],body:Buffer.from('<!doctype html><meta charset="utf-8"><title>Fo 独立任务窗口</title><body><p>此窗口只运行 Fo。重新登录或查看完整 AutoDL 控制台，请使用终端 fo login。</p></body>').toString('base64')},e.sessionId):cdp.call('Fetch.continueRequest',{requestId:params.requestId},e.sessionId);
      void action.catch(()=>{});
    });
  }
  async install(sessionId){
    if(this.sessions.has(sessionId))return;
    this.sessions.add(sessionId);
    try{
      await this.cdp.call('Page.enable',{},sessionId);
      await this.cdp.call('Runtime.enable',{},sessionId);
      await this.cdp.call('Runtime.addBinding',{name:'__fo_cli_store'},sessionId);
      await this.cdp.call('Fetch.enable',{patterns:[{urlPattern:RUNNER_URL,resourceType:'Document',requestStage:'Request'}]},sessionId);
      const nonce=randomBytes(24).toString('hex');this.nonces.set(sessionId,nonce);
      const source=`if(location.href===${JSON.stringify(RUNNER_URL)})addEventListener('DOMContentLoaded',async()=>{
        const nonce=${JSON.stringify(nonce)},requests=new Map();let seq=0;
        globalThis.__fo_cli_reply=(id,ok,value)=>{const r=requests.get(id);if(r){requests.delete(id);ok?r.resolve(value):r.reject(new Error(value));}};
        const send=(op,value)=>new Promise((resolve,reject)=>{const id=++seq;requests.set(id,{resolve,reject});globalThis.__fo_cli_store(JSON.stringify({nonce,seq:id,op,value}));});
        const saved=await send('get');(${installGM.toString()})(saved,value=>send('set',value));\n${this.source}\n},{once:true});`;
      await this.cdp.call('Page.addScriptToEvaluateOnNewDocument',{source},sessionId);
    }catch(e){this.sessions.delete(sessionId);throw e;}
  }
  flush(){return this.tail;}
  async activate(sessionId){
    await this.install(sessionId);await this.cdp.call('Page.navigate',{url:RUNNER_URL},sessionId);
    const until=Date.now()+60000;
    do{
      let ready=false;
      try{ready=await this.cdp.evaluate(sessionId,`location.href===${JSON.stringify(RUNNER_URL)}&&!!document.getElementById('autodl-helper-host')?.shadowRoot`);}
      catch{}
      await this.flush();if(ready)return;
      await new Promise(r=>setTimeout(r,250));
    }while(Date.now()<until);
    throw new Error('Fo 任务页面初始化超时，请运行 fo doctor 核对');
  }
}
