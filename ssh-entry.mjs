import {userInfo} from 'node:os';import {readFile} from 'node:fs/promises';
import {authorizeSSH} from './lib/tenant.mjs';import {runRPC} from './rpc.mjs';
try{
  const username=userInfo().username;
  if(!/^fo-u-[a-z][a-z0-9-]{0,23}$/.test(username))throw new Error('无效 SSH 身份');
  const config=JSON.parse(await readFile('/etc/fo-autodl/users/'+username+'.json','utf8'));
  const tenant=authorizeSSH(username,config,process.env.SSH_ORIGINAL_COMMAND);
  await runRPC(tenant.socket);
}catch(e){console.error(e.message);process.exitCode=1;}
