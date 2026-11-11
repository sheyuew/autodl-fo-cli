import {setTimeout as delay} from 'node:timers/promises';
export async function submitLogin(cdp,session,{username,password},{timeout=20000}={}){
  const end=Date.now()+timeout;let submitted=false;
  while(Date.now()<end){
    const result=await cdp.evaluate(session,`(${loginForm.toString()})(${JSON.stringify({username,password,submit:!submitted})})`);
    if(result.state==='authenticated'||result.state==='verification'||result.state==='failed')return result;
    if(result.state==='submitted')submitted=true;await delay(200);
  }
  return {state:'verification',message:'自动登录未完成，请在浏览器检查网络或平台验证'};
}
function loginForm({username,password,submit}){
  let user={};try{user=JSON.parse(localStorage.getItem('user')||'{}');}catch{}
  if(localStorage.getItem('token')&&(user.uuid||user.id)){
    if(![user.sub_name,user.username,user.user_name,user.phone].includes(username))return {state:'failed',message:'该环境已登录其他账号，请切换账号或用新邀请码添加'};
    return {state:'authenticated',account:`${user.uuid||user.id}:${user.sub_name||''}`};
  }
  const errors=[...document.querySelectorAll('.el-form-item__error,.el-message--error,.el-alert--error')].map(x=>x.textContent.trim()).filter(Boolean);
  if(!submit&&errors.length)return {state:'failed',message:errors.join('；').replaceAll(password,'[已隐藏]').slice(0,200)};
  const visible=x=>!!(x&&x.getClientRects().length);
  if([...document.querySelectorAll('[id*="captcha"],[class*="captcha"],input[name="v_code"]')].some(visible))return {state:'verification',message:'平台要求验证码或滑块验证'};
  if(!submit)return {state:'waiting'};
  const name=document.querySelector('input[name="username"],input[name="phone"]'),secret=document.querySelector('input[name="password"]');
  const button=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='登录');
  if(!name||!secret||!button)return {state:'loading'};
  const set=(element,value)=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(element,value);element.dispatchEvent(new Event('input',{bubbles:true}));element.dispatchEvent(new Event('change',{bubbles:true}));};
  set(name,username);set(secret,password);button.click();return {state:'submitted'};
}
