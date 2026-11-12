const origin='https://www.autodl.com';
const endpoints=Object.freeze({
  instances:{path:'/api/v1/instance',method:'POST'},
  regions:{path:'/api/v1/region/list',method:'GET'},
  gpuTypes:{path:'/api/v1/machine/gpu_type',method:'GET'},
  regionalGpus:{path:'/api/v1/machine/region/gpu_type',method:'POST'},
  machines:{path:'/api/v1/user/machine/list',method:'POST'},
  instanceSnapshot:{path:'/api/v1/instance/snapshot',method:'GET',query:['instance_uuid']},
});
function failure(code,message,details={}){return Object.assign(new Error(message),{code,...details});}

/** Read-only web-session backend. No credentials or sessions are written to disk. */
export class WebClient{
  #session;#expired=false;#baseUrl;#timeoutMs;
  constructor({session,expectedUsername,baseUrl=origin,timeoutMs=15000}){
    const user=session?.user,username=user?.sub_name||user?.username||user?.phone;
    if(!session?.token||!(user?.uuid||user?.id)||!username)throw failure('LOGIN_REQUIRED','缺少已验证的 AutoDL 登录会话');
    if(expectedUsername&&expectedUsername!==username)throw failure('ACCOUNT_MISMATCH','登录会话属于其他账号');
    const u=new URL(baseUrl);
    if(u.origin!==origin&&!(u.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(u.hostname)))throw failure('INVALID_ORIGIN','只允许 AutoDL 官方域名或本地测试服务');
    this.#session=structuredClone(session);this.#baseUrl=u.origin;this.#timeoutMs=timeoutMs;
    this.identity=Object.freeze({id:String(user.uuid||user.id),username,subaccount:!!user.sub_name});
  }
  async read(operation,body){
    if(!Object.hasOwn(endpoints,operation))throw failure('READ_ONLY','验证版只允许读取实例和库存');
    if(this.#expired)throw failure('LOGIN_REQUIRED','AutoDL 登录已过期，请重新登录');
    const endpoint=endpoints[operation],path=this.identity.subaccount?endpoint.path.replace('/api/v1/','/api/v1/sub_user/'):endpoint.path;
    const url=new URL(this.#baseUrl+path);for(const key of endpoint.query||[])if(body?.[key]!=null)url.searchParams.set(key,String(body[key]));
    let response;const signal=AbortSignal.timeout(this.#timeoutMs);
    try{response=await fetch(url,{method:endpoint.method,redirect:'error',headers:{Authorization:this.#session.token,AppVersion:this.#session.appVersion||'0.0.0','Content-Type':'application/json',Accept:'application/json','User-Agent':'autodl-subaccount-poc'},...(endpoint.method==='POST'?{body:JSON.stringify(body||{})}:{}),signal});}
    catch{throw failure('NETWORK','AutoDL 请求失败或超时',{retryable:true});}
    if(!response.ok){
      try{await response.body?.cancel();}catch{}
      if(response.status===401){this.#expired=true;throw failure('LOGIN_REQUIRED','AutoDL 登录已过期，请重新登录');}
      if(response.status===403)throw failure('PERMISSION_DENIED','该子账号没有此接口的权限');
      if(response.status===429){
        const raw=response.headers.get('Retry-After'),seconds=raw==null?NaN:Number(raw);
        throw failure('RATE_LIMITED','AutoDL 暂时限制了请求频率，请稍后重试',{retryable:true,...(Number.isFinite(seconds)&&seconds>=0?{retryAfterSeconds:seconds}:{})});
      }
      throw failure('API_ERROR','AutoDL 读取服务暂时不可用',{providerCode:`HTTP${response.status}`,retryable:response.status===408||response.status>=500});
    }
    let envelope;
    try{envelope=await response.json();}catch(error){
      if(signal.aborted||error?.name==='AbortError'||error instanceof TypeError)throw failure('NETWORK','AutoDL 响应中断或超时',{retryable:true});
      throw failure('SCHEMA_CHANGED','AutoDL 响应不是 JSON');
    }
    if(!envelope||typeof envelope!=='object'||Array.isArray(envelope)||typeof envelope.code!=='string')throw failure('SCHEMA_CHANGED','AutoDL 响应结构发生变化');
    if(['AuthorizeFailed','Unauthorized','TokenExpired','TokenInvalid'].includes(envelope.code)){
      this.#expired=true;throw failure('LOGIN_REQUIRED','AutoDL 登录已过期，请重新登录');
    }
    if(envelope.code!=='Success')throw failure('API_ERROR','AutoDL 拒绝了读取请求',{providerCode:envelope.code.slice(0,80)});
    return envelope.data;
  }
  async #pages(operation,body){
    const rows=[];
    for(let page=1;page<=100;page++){
      const data=await this.read(operation,{...body,page_index:page,page_size:90});
      if(!Array.isArray(data?.list))throw failure('SCHEMA_CHANGED','AutoDL 列表结构发生变化');
      rows.push(...data.list);
      if(!data.list.length||(data.result_total!=null?rows.length>=Number(data.result_total):data.list.length<(Number(data.page_size)||90)))return rows;
    }
    throw failure('SCHEMA_CHANGED','AutoDL 列表分页超过验证版上限');
  }
  instances(){return this.#pages('instances',{status:[],charge_type:[],name:'',sub_name:''});}
  snapshot(uuid){if(typeof uuid!=='string'||!uuid.trim())throw failure('INSTANCE_REQUIRED','请先选择实例');return this.read('instanceSnapshot',{instance_uuid:uuid});}
  regions(){return this.read('regions');}
  gpuTypes(){return this.read('gpuTypes');}
  regionalGpus(regionSigns){return this.read('regionalGpus',{region_sign_list:regionSigns});}
  machines({regionSigns,gpuNames=[],idle=1}){
    if(!Array.isArray(regionSigns)||!regionSigns.length)throw failure('REGION_REQUIRED','请先选择地区');
    return this.#pages('machines',{charge_type:'payg',gpu_type_name:gpuNames,gpu_idle_num:idle,region_sign_list:regionSigns,default_order:true,machine_tag_name:[],mount_net_disk:false,cpu_arch:[],chip_corp:[],instance_disk_size_order:'',date_range:'',date_from:'',date_to:'',pay_price_order:'',gpu_idle_type:''});
  }
}
