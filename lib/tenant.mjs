import {join} from 'node:path';import {readJSON,writeJSON} from './storage.mjs';
export function tenantRuntime(config){
  if(!config)return {id:'owner',user:'fo-autodl',state:'/var/lib/fo-autodl',profile:'/var/lib/fo-autodl/profile',socket:'/var/lib/fo-autodl/control.sock',plans:'/var/lib/fo-autodl/cli-plans',display:':99',webPort:6080,vncPort:5900};
  const {id,slot}=config;
  if(typeof id!=='string'||id==='owner'||!/^[a-z][a-z0-9-]{0,23}$/.test(id)||!Number.isInteger(slot)||slot<1||slot>50)throw new Error('账号代号或分配槽位无效（owner 为保留名称）');
  const state='/var/lib/fo-tenants/'+id;
  return {id,slot,user:'fo-u-'+id,state,profile:state+'/profile',socket:state+'/control.sock',plans:state+'/cli-plans',display:':'+(100+slot),webPort:6080+slot,vncPort:5900+slot};
}
export function authorizeSSH(username,config,command){
  const tenant=tenantRuntime(config);
  if(tenant.user!==username)throw new Error('SSH 身份与账号不一致');
  if(command!=='fo-rpc')throw new Error('仅允许 Fo 命令，不提供服务器 shell');
  return tenant;
}
export class AccountBinding{
  constructor(state){this.path=join(state,'account-binding.json');}
  async check(health){
    if(!health.authenticated||!health.account)throw new Error('AutoDL 未登录或登录已过期，请运行 fo login');
    const saved=await readJSON(this.path,null);
    if(saved&&saved.account!==health.account)throw new Error('当前 AutoDL 账号与本环境绑定账号不同，请切回原账号；更换账号需管理员处理');
    if(!saved)await writeJSON(this.path,{account:health.account,boundAt:new Date().toISOString()});
    return health.account;
  }
}
