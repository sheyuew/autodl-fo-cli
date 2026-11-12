import test from 'node:test';import assert from 'node:assert/strict';import {createServer} from 'node:net';import {once} from 'node:events';import {mkdtemp,writeFile,chmod} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir} from 'node:os';import {runTerminal} from './terminal-utils.mjs';
test('remote terminal uses SSH requests for login and panel queries, accepting sanitized instance rows',{timeout:20000},async t=>{
 const dir=await mkdtemp(join(tmpdir(),'fo-remote-')),socket=join(dir,'s'),seen=[];
 const identity={id:'user-a',username:'alice@team',subaccount:true};
 const server=createServer({allowHalfOpen:true},conn=>{let input='';conn.on('data',chunk=>input+=chunk);conn.on('end',()=>{const q=JSON.parse(input);seen.push(q);let result;
  if(q.op==='doctor')result={backend:'native-http',authenticated:false};
  else if(q.op==='login-password')result={identity,state:'authenticated'};
  else if(q.op==='instances')result=[{uuid:'instance-a',name:'remote-fixture-instance',status:'running',has_auto_panel:true}];
  else if(q.op==='panel-open')result={handle:'h'};
  else if(q.op==='panel-login')result={authenticated:true};
  else if(q.op==='panel-read'&&q.query==='activeTasks')result={task_doing:[],task_success:1,task_total:1};
  else assert.fail('unexpected remote request');conn.end(JSON.stringify({ok:true,result})+'\n');});});server.listen(socket);await once(server,'listening');t.after(()=>server.close());
 const ssh=join(dir,'ssh');await writeFile(ssh,"#!/usr/bin/env node\nconst net=require('net');let data='';process.stdin.on('data',x=>data+=x);process.stdin.on('end',()=>{const c=net.createConnection(process.env.FO_TEST_SOCKET);c.on('connect',()=>c.end(data));c.pipe(process.stdout);});\n");await chmod(ssh,0o755);
 const config=join(dir,'config.json');await writeFile(config,JSON.stringify({host:'fixture@host.invalid',port:22,identityFile:'/fixture/key',protocol:'multi-v1'}));
 const result=await runTerminal({args:['--remote',config],env:{PATH:dir+':'+process.env.PATH,FO_TEST_SOCKET:socket},steps:[
  {wait:'AutoDL 子账号：',send:'alice@team\n'},{wait:'密码（不回显）：',send:'fixture-password\n'},
  {wait:'选择操作',send:'1\n'},{wait:'选择操作',count:2,send:'4\n'},{wait:'选择实例编号',send:'1\n'},
  {wait:'AutoPanel 独立密码（不回显）',send:'fixture-panel-password\n'},{wait:'AutoPanel 操作',send:'3\n'},
  {wait:'AutoPanel 操作',count:2,send:'q\n'},{wait:'选择操作',count:3,send:'q\n'}]},t);
 assert.equal(result.code,0,result.error);assert.ok(result.output.includes('remote-fixture-instance'));assert.ok(result.output.includes('正在传输 0 项'));assert.ok(!result.output.includes('fixture-password'));assert.ok(!result.output.includes('fixture-panel-password'));
 assert.equal(seen.filter(q=>q.op==='login-password').length,1);assert.equal(seen.filter(q=>q.op==='panel-read').length,1);
});
