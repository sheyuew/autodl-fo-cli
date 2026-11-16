import {createHash} from 'node:crypto';
import {platform,release} from 'node:os';
const origin='https://www.autodl.com';
const failure=(code,message,details={})=>Object.assign(new Error(message),{code,...details});

/** Mirrors the public subaccount form. Passwords and tickets stay in memory. */
export async function loginSubaccount({username,password},{baseUrl=origin,appVersion='0.0.0',timeoutMs=15000}={}){
  if(typeof username!=='string'||!username.includes('@')||typeof password!=='string'||!password)throw failure('CREDENTIALS_REQUIRED','请输入子账号和密码');
  const u=new URL(baseUrl);
  if(u.origin!==origin&&!(u.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(u.hostname)))throw failure('INVALID_ORIGIN','只允许 AutoDL 官方域名或本地测试服务');
  async function post(path,body,stage){
    let response,envelope;
    try{
      response=await fetch(u.origin+path,{method:'POST',redirect:'error',headers:{'Content-Type':'application/json',AppVersion:appVersion,Accept:'application/json','User-Agent':'autodl-subaccount-poc'},body:JSON.stringify(body),signal:AbortSignal.timeout(timeoutMs)});
    }catch{throw failure('NETWORK',`AutoDL ${stage}请求失败或超时`);}
    if(response.status===429||response.status===408||response.status>=500){
      try{await response.body?.cancel();}catch{}
      const raw=response.headers.get('Retry-After'),seconds=raw===null?NaN:Number(raw);
      if(response.status===429)throw failure('RATE_LIMITED',`AutoDL ${stage}请求被限流（HTTP 429），请稍后重试`,{retryable:true,...(Number.isFinite(seconds)&&seconds>=0?{retryAfterSeconds:seconds}:{})});
      throw failure('API_ERROR',`AutoDL ${stage}服务暂时不可用（HTTP ${response.status}），请稍后重试`,{retryable:true});
    }
    try{envelope=await response.json();}catch(error){
      if(error?.name==='AbortError'||error instanceof TypeError)throw failure('NETWORK',`AutoDL ${stage}响应中断或超时`);
      throw failure(response.ok?'SCHEMA_CHANGED':'API_ERROR',`AutoDL ${stage}返回非 JSON 响应（HTTP ${response.status}）`);
    }
    if(!envelope||typeof envelope!=='object'||Array.isArray(envelope)||typeof envelope.code!=='string')throw failure('SCHEMA_CHANGED',`AutoDL ${stage}响应结构发生变化（HTTP ${response.status}）`);
    if(!response.ok||envelope.code!=='Success'){
      const providerCode=/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(envelope.code)?envelope.code:'UnrecognizedCode';
      throw failure('LOGIN_REJECTED',`AutoDL ${stage}未通过（HTTP ${response.status}；业务码：${providerCode}），尚未登录`,{providerCode});
    }
    return envelope.data;
  }
  const hashed=createHash('sha1').update(password).digest('hex');
  const first=await post('/api/v1/sub_user/login',{sub_name:username,password:hashed},'账号验证');
  if(first?.user?.sub_name!==username)throw failure('ACCOUNT_MISMATCH','登录响应属于其他账号');
  if(typeof first.ticket!=='string'||!(first.user.uuid||first.user.id))throw failure('SCHEMA_CHANGED','AutoDL 登录响应结构发生变化');
  const second=await post('/api/v1/sub_user/passport',{ticket:first.ticket,device:{os:{name:platform(),version:release()},browser:{name:'Node.js',version:process.versions.node,major:process.versions.node.split('.')[0]}}},'会话换取');
  if(typeof second?.token!=='string'||!second.token)throw failure('SCHEMA_CHANGED','AutoDL 未返回登录会话');
  return {token:second.token,user:{id:first.user.id,uuid:first.user.uuid,sub_name:first.user.sub_name,username:first.user.user_name},appVersion};
}
