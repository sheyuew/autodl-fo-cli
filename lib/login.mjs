import {setTimeout as delay} from 'node:timers/promises';
export async function requireLogin(cdp,session,username,{onProgress}={}){
  const health=await cdp.evaluate(session,`(${loginIdentity.toString()})(${JSON.stringify({username})})`);
  onProgress?.({...health,state:health.authenticated?'authenticated':'unauthenticated'});
  if(!health.authenticated)throw Object.assign(new Error('AutoDL 尚未登录成功，请先在浏览器完成登录，再回终端确认；也可重新运行 fo login'),{code:'LOGIN_REQUIRED'});
  if(!health.identityMatches)throw Object.assign(new Error('浏览器登录账号与终端输入不符，请核对后重试'),{code:'ACCOUNT_MISMATCH'});
  return health;
}
export async function submitLogin(cdp,session,{username,password},{timeout=20000,onProgress}={}){
  const end=Date.now()+timeout;let submitted=false,lastProgress;
  const report=result=>{const next=JSON.stringify(result);if(next!==lastProgress){lastProgress=next;onProgress?.(result);}};
  while(Date.now()<end){
    let result;
    try{result=await cdp.evaluate(session,`(${loginForm.toString()})(${JSON.stringify({username,password,submit:!submitted})},${loginIdentity.toString()})`);}
    catch(e){
      const reason=/context|navigat/i.test(e.message)?'context_changed':/超时|timed? ?out/i.test(e.message)?'chrome_timeout':'automation_error';
      report({state:'failed',reason});
      throw Object.assign(new Error('自动登录未完成，请检查网络或使用 fo login-browser'),{code:'LOGIN_AUTOMATION_FAILED'});
    }
    report(result);
    if(result.state==='authenticated'||result.state==='verification'||result.state==='failed')return result;
    if(result.state==='submitted')submitted=true;await delay(200);
  }
  const result={state:'verification',reason:'timeout',message:'等待 AutoDL 页面或登录结果超时，请在浏览器检查网络或平台验证'};
  report(result);return result;
}
function loginIdentity({username}){
  let user={},hasToken=false,storageReady=true;
  try{user=JSON.parse(localStorage.getItem('user')||'{}')||{};hasToken=!!localStorage.getItem('token');}catch{storageReady=false;}
  const identity=user.uuid||user.id,account=identity?`${identity}:${user.sub_name||''}`:'';
  return {authenticated:!!(hasToken&&identity),account,identityMatches:!username||[user.sub_name,user.username,user.user_name,user.phone].includes(username),hasToken,hasUser:!!identity,storageReady,readyState:document.readyState,path:location.pathname};
}
function loginForm({username,password,submit},inspect){
  const health=inspect({username});
  if(health.authenticated){
    if(!health.identityMatches)return {state:'failed',reason:'account_mismatch',message:'该环境已登录其他账号，请切换账号或用新邀请码添加'};
    return {state:'authenticated',account:health.account};
  }
  const errors=[...document.querySelectorAll('.el-form-item__error,.el-message--error,.el-alert--error')].map(x=>x.textContent.trim()).filter(Boolean);
  if(!submit&&errors.length)return {state:'failed',reason:'form_error',message:errors.join('；').replaceAll(password,'[已隐藏]').replaceAll(username,'[账号]').slice(0,200)};
  const visible=x=>!!(x&&x.getClientRects().length);
  if([...document.querySelectorAll('[id*="captcha"],[class*="captcha"],input[name="v_code"]')].some(visible))return {state:'verification',reason:'captcha',message:'平台要求验证码或滑块验证'};
  if(!submit)return {state:'waiting',...health};
  const name=document.querySelector('input[name="username"],input[name="phone"]'),secret=document.querySelector('input[name="password"]');
  const button=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='登录');
  if(!name||!secret||!button)return {state:'loading',...health,hasUsernameInput:!!name,hasPasswordInput:!!secret,hasLoginButton:!!button};
  const set=(element,value)=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(element,value);element.dispatchEvent(new Event('input',{bubbles:true}));element.dispatchEvent(new Event('change',{bubbles:true}));};
  set(name,username);set(secret,password);button.click();return {state:'submitted'};
}
