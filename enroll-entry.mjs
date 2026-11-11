import {userInfo} from 'node:os';import {createConnection} from 'node:net';import {cleanPublicKey} from './lib/provision.mjs';
try{
  const invitation=process.argv[2];
  if(userInfo().username!=='fo-enroll'||process.env.SSH_ORIGINAL_COMMAND!=='fo-enroll'||!/^[a-f0-9]{32}$/.test(invitation))throw new Error('仅允许兑换邀请码');
  let input='';for await(const part of process.stdin){input+=part;if(input.length>4096)throw new Error('请求过大');}
  const publicKey=cleanPublicKey(JSON.parse(input).publicKey),conn=createConnection('/run/fo-enroll/enroll.sock');
  conn.setEncoding('utf8');conn.setTimeout(150000,()=>conn.destroy(new Error('兑换超时，请使用原邀请码重试')));let output='';
  conn.on('connect',()=>conn.write(JSON.stringify({invitation,publicKey})+'\n'));
  conn.on('data',part=>{output+=part;if(output.length>16384){conn.destroy();return;}if(output.includes('\n')){process.stdout.write(output.slice(0,output.indexOf('\n'))+'\n');conn.end();}});
  conn.on('error',()=>{console.error('接入服务暂时不可用，请稍后使用原邀请码重试');process.exitCode=1;});
}catch(e){console.error(e.message);process.exitCode=1;}
