import {randomUUID} from 'node:crypto';

const operations=new Set(['notifications','viewer','login-password','login','activate','doctor','status','catalog','prepare','start','result']);
const states=new Set(['loading','submitted','waiting','authenticated','unauthenticated','verification','failed']);
const reasons=new Set(['timeout','form_error','captcha','account_mismatch','context_changed','chrome_timeout','automation_error']);
const codes=new Set(['LOGIN_REQUIRED','ACCOUNT_MISMATCH','LOGIN_AUTOMATION_FAILED','RPC_FAILED']);
const paths=new Set(['/login','/subAccountLogin','/console/instance/list','/__fo_cli_runner__']);
const booleans=['authenticated','identityMatches','hasToken','hasUser','storageReady','hasUsernameInput','hasPasswordInput','hasLoginButton'];

export function rpcErrorCode(error){
  if(codes.has(error?.code))return error.code;
  if(/AutoDL (?:未登录|尚未登录|页面尚未就绪)/.test(error?.message||''))return 'LOGIN_REQUIRED';
  if(/绑定.*账号|账号.*不符/.test(error?.message||''))return 'ACCOUNT_MISMATCH';
  return 'RPC_FAILED';
}

function progress(value){
  const result={};
  if(states.has(value?.state))result.state=value.state;
  if(reasons.has(value?.reason))result.reason=value.reason;
  if(['loading','interactive','complete'].includes(value?.readyState))result.readyState=value.readyState;
  if(typeof value?.path==='string')result.path=paths.has(value.path)?value.path:'other';
  for(const key of booleans)if(typeof value?.[key]==='boolean')result[key]=value[key];
  return result;
}

// Only explicitly allowed metadata enters the journal. Never serialize requests,
// results, exception messages, credentials, account names or browser storage.
export class RpcAudit{
  constructor(tenant,write=line=>console.log(line)){this.tenant=tenant;this.write=write;}
  request(operation){
    const id=randomUUID(),op=operations.has(operation)?operation:'unknown',received=Date.now();
    const emit=(event,fields={})=>this.write(JSON.stringify({at:new Date().toISOString(),event,tenant:this.tenant,requestId:id,op,...fields}));
    emit('rpc.received');
    return {id,login:value=>emit('login.stage',progress(value)),run:async work=>{
      const started=Date.now();emit('rpc.started',{queueMs:started-received});
      try{
        const result=await work();
        emit('rpc.finished',{ok:true,durationMs:Date.now()-started,...progress(result)});
        return result;
      }catch(error){
        emit('rpc.finished',{ok:false,durationMs:Date.now()-started,code:rpcErrorCode(error)});
        throw error;
      }
    }};
  }
}
