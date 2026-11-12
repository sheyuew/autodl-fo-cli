import {createHash} from 'node:crypto';
import {platform,release} from 'node:os';
const origin='https://www.autodl.com';
const failure=(code,message)=>Object.assign(new Error(message),{code});

/** Mirrors the public subaccount form. Passwords and tickets stay in memory. */
export async function loginSubaccount({username,password},{baseUrl=origin,appVersion='0.0.0',timeoutMs=15000}={}){
  if(typeof username!=='string'||!username.includes('@')||typeof password!=='string'||!password)throw failure('CREDENTIALS_REQUIRED','请输入子账号和密码');
  const u=new URL(baseUrl);
  if(u.origin!==origin&&!(u.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(u.hostname)))throw failure('INVALID_ORIGIN','只允许 AutoDL 官方域名或本地测试服务');
  async function post(path,body){
    let response,envelope;
    try{
      response=await fetch(u.origin+path,{method:'POST',redirect:'error',headers:{'Content-Type':'application/json',AppVersion:appVersion,Accept:'application/json','User-Agent':'autodl-subaccount-poc'},body:JSON.stringify(body),signal:AbortSignal.timeout(timeoutMs)});
      envelope=await response.json();
    }catch{throw failure('NETWORK','AutoDL 登录请求失败或超时');}
    if(!response.ok||envelope.code!=='Success')throw failure('LOGIN_REJECTED','AutoDL 拒绝了登录，请核对凭据或在官网完成验证');
    return envelope.data;
  }
  const hashed=createHash('sha1').update(password).digest('hex');
  const first=await post('/api/v1/sub_user/login',{sub_name:username,password:hashed});
  if(first?.user?.sub_name!==username)throw failure('ACCOUNT_MISMATCH','登录响应属于其他账号');
  if(typeof first.ticket!=='string'||!(first.user.uuid||first.user.id))throw failure('SCHEMA_CHANGED','AutoDL 登录响应结构发生变化');
  const second=await post('/api/v1/sub_user/passport',{ticket:first.ticket,device:{os:{name:platform(),version:release()},browser:{name:'Node.js',version:process.versions.node,major:process.versions.node.split('.')[0]}}});
  if(typeof second?.token!=='string'||!second.token)throw failure('SCHEMA_CHANGED','AutoDL 未返回登录会话');
  return {token:second.token,user:{id:first.user.id,uuid:first.user.uuid,sub_name:first.user.sub_name,username:first.user.user_name},appVersion};
}
