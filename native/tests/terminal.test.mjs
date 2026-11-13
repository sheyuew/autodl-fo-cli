import test from 'node:test';import assert from 'node:assert/strict';import {createServer} from 'node:http';import {once} from 'node:events';import {runTerminal} from './terminal-utils.mjs';

async function fixture(t,{failOnce=false,panel=false,collision=false,directory=false}={}){
  let loginCalls=0,instanceCalls=0,panelLoginCalls=0;
  const transfers=[];
  const web=createServer(async(q,r)=>{
    let body='';for await(const p of q)body+=p;const b=body?JSON.parse(body):{};
    if(q.url==='/api/v1/sub_user/login')loginCalls++;
    if(q.url.startsWith('/autopanel/v1/')){
      assert.equal(q.headers.autodlautopaneltoken,'panel-outer-secret');let data;
      if(q.url.endsWith('/sign_in')){
        panelLoginCalls++;assert.equal(q.method,'POST');
        if(b.password!=='19628a3cc9d0a2d5cbc78ac9c33e98082ebc55e4'){r.end(JSON.stringify({code:'success',data:{code:'AuthFailed'}}));return;}
        data='panel-inner-secret';
      }else{
        assert.equal(q.headers.authorization,'panel-inner-secret');
        const u=new URL(q.url,'http://localhost');
        if(u.pathname.endsWith('/workdir'))data='/root/autodl-tmp';
        else if(u.pathname==='/autopanel/v1/file')data=[{filename:'fixture-local.txt',is_dir:false,size_in_byte:100},...(directory?[{filename:'folder',is_dir:true}]:[]),...(collision?[{filename:'fixture-cloud-child.txt',is_dir:false,size_in_byte:10}]:[])];
        else if(u.pathname.endsWith('/netdisk/list'))data=[{fs_id:'fixture-disk',type:'AutoDL_AliPan',user_info:{resource_drive_id:'resource-drive'}}];
        else if(u.pathname.endsWith('/netdisk/file')){
          assert.equal(u.searchParams.get('driver_id'),'resource-drive');
          data={list:{List:u.searchParams.get('file_id')==='/'?[{name:'fixture-cloud-folder',file_id:'folder-id',is_dir:true},...(collision?[{name:'fixture-local.txt',file_id:'existing-file',is_dir:false,size:100}]:[])]:[{name:'fixture-cloud-child.txt',file_id:'child-id',is_dir:false,size:10,download_url:'private-download-url-must-stay-hidden'}]},next_marker:''};
        }else if(u.pathname.endsWith('/task/doing'))data={task_doing:[],task_success:1,task_total:1};
        else if(u.pathname.endsWith('/task'))data={task_doing:[],task_pre:[],task_done:[{file_name:'fixture-history.txt',status:'success',task_type:2,download_url:'private-download-url-must-stay-hidden'}]};
        else if(['/autopanel/v1/netdisk/upload','/autopanel/v1/netdisk/download'].includes(u.pathname)){
          assert.equal(q.method,'POST');transfers.push({path:u.pathname,body:b});data={task_id:'fixture-task'};
        }else assert.fail('unexpected panel operation');
      }
      r.end(JSON.stringify({code:'success',data}));return;
    }
    if(q.url==='/api/v1/sub_user/instance'){instanceCalls++;if(failOnce&&instanceCalls===1){r.statusCode=503;r.end('Service Unavailable');return;}}
    const data=q.url==='/api/v1/sub_user/login'&&b.password==='5baa61e4c9b93f3f0682250b6cf8331b7ee68fd8'?{ticket:'test-ticket',user:{id:1,sub_name:'alice@team'}}:
      q.url==='/api/v1/sub_user/passport'?{token:'terminal-token-must-stay-hidden'}:
      q.url==='/api/v1/sub_user/instance'&&q.headers.authorization==='terminal-token-must-stay-hidden'?{list:[{uuid:'fixture-id',name:'fixture-instance',status:panel?'running':'shutdown',has_auto_panel:true,jupyter_token:'panel-outer-secret',proxy_host:'127.0.0.1',jupyter_port:web.address().port}],result_total:1}:undefined;
    r.end(JSON.stringify(data?{code:'Success',data}:{code:'UnexpectedRequest'}));
  });web.listen(0,'127.0.0.1');await once(web,'listening');t.after(()=>{web.closeAllConnections();web.close();});
  return {baseUrl:`http://127.0.0.1:${web.address().port}`,counts:()=>({loginCalls,instanceCalls}),panelLoginCalls:()=>panelLoginCalls,transfers};
}
const loginSteps=[{wait:'AutoDL 子账号：',send:'alice@team\n'},{wait:'密码（不回显）：',send:'password\n'},{wait:'选择操作',send:'1\n'}];
function verify(result){assert.equal(result.code,0,result.error);assert.ok(result.output.includes('fixture-instance'));assert.ok(!result.output.includes('password'));assert.ok(!result.output.includes('terminal-token-must-stay-hidden'));}

test('real terminal hides the password, reads instances and exits without exposing the session token',{timeout:15000},async t=>{
  const web=await fixture(t);verify(await runTerminal({baseUrl:web.baseUrl,steps:[...loginSteps,{wait:'选择操作',count:2,send:'q\n'}]},t));assert.deepEqual(web.counts(),{loginCalls:1,instanceCalls:1});
});

test('terminal preserves login after a temporary failure and lets the user retry without entering a password again',{timeout:15000},async t=>{
  const web=await fixture(t,{failOnce:true});verify(await runTerminal({baseUrl:web.baseUrl,steps:[...loginSteps,{wait:'选择操作',count:2,send:'1\n'},{wait:'选择操作',count:3,send:'q\n'}]},t));
  assert.deepEqual(web.counts(),{loginCalls:1,instanceCalls:2});
});

const panelSteps=[...loginSteps.slice(0,2),{wait:'选择操作',send:'4\n'},{wait:'选择实例编号',send:'1\n'},{wait:'AutoPanel 独立密码（不回显）',send:'panel-password\n'}];
function verifyPanel(result){
  assert.equal(result.code,0,result.error);
  for(const secret of ['password','panel-inner-secret','panel-outer-secret','terminal-token-must-stay-hidden','private-download-url-must-stay-hidden'])assert.ok(!result.output.includes(secret),`terminal leaked ${secret}`);
}
test('real terminal selects an instance, reads local and cloud folders and transfer status without exposing credentials',{timeout:20000},async t=>{
  const web=await fixture(t,{panel:true});
  const result=await runTerminal({baseUrl:web.baseUrl,steps:[...panelSteps,
    {wait:'AutoPanel 操作',send:'1\n'},{wait:'本地目录路径',send:'\n'},
    {wait:'AutoPanel 操作',count:2,send:'2\n'},{wait:'选择网盘编号',send:'1\n'},{wait:'选择空间',send:'1\n'},
    {wait:'目录操作',send:'1\n'},{wait:'目录操作',count:2,send:'q\n'},
    {wait:'AutoPanel 操作',count:3,send:'3\n'},{wait:'AutoPanel 操作',count:4,send:'4\n'},
    {wait:'AutoPanel 操作',count:5,send:'q\n'},{wait:'选择操作',count:2,send:'q\n'}]},t);
  verifyPanel(result);for(const value of ['fixture-local.txt','fixture-cloud-child.txt','fixture-history.txt','正在传输 0 项'])assert.ok(result.output.includes(value),`missing ${value}`);
  assert.deepEqual(web.counts(),{loginCalls:1,instanceCalls:1});assert.equal(web.panelLoginCalls(),1);
});

test('a wrong panel password can be corrected inside the submenu without losing the AutoDL account',{timeout:20000},async t=>{
  const web=await fixture(t,{panel:true});const steps=panelSteps.map(x=>({...x}));steps.at(-1).send='wrong\n';
  const result=await runTerminal({baseUrl:web.baseUrl,steps:[...steps,{wait:'AutoPanel 操作',send:'p\n'},{wait:'AutoPanel 独立密码（不回显）',count:2,send:'panel-password\n'},{wait:'AutoPanel 操作',count:2,send:'3\n'},{wait:'AutoPanel 操作',count:3,send:'q\n'},{wait:'选择操作',count:2,send:'q\n'}]},t);
  verifyPanel(result);assert.ok(result.output.includes('PANEL_LOGIN_REQUIRED'));assert.ok(result.output.includes('正在传输 0 项'));assert.deepEqual(web.counts(),{loginCalls:1,instanceCalls:1});assert.equal(web.panelLoginCalls(),2);
});

const uploadSteps=[{wait:'AutoPanel 操作',send:'5\n'},{wait:'实例文件绝对路径',send:'/root/autodl-tmp/fixture-local.txt\n'},{wait:'选择网盘编号',send:'1\n'},{wait:'选择空间',send:'1\n'},{wait:'目录操作',send:'s\n'}];
test('terminal validates yes/no and a declined upload sends no transfer request',{timeout:20000},async t=>{
  const web=await fixture(t,{panel:true});
  const result=await runTerminal({baseUrl:web.baseUrl,steps:[...panelSteps,...uploadSteps,
    {wait:'确认提交 [yes/no]',send:'maybe\n'},{wait:'确认提交 [yes/no]',count:2,send:'no\n'},
    {wait:'AutoPanel 操作',count:2,send:'q\n'},{wait:'选择操作',count:2,send:'q\n'}]},t);
  verifyPanel(result);assert.ok(result.output.includes('已取消'));assert.equal(web.transfers.length,0);
});

test('terminal submits uploads and downloads once after showing paths and receiving yes',{timeout:20000},async t=>{
  const web=await fixture(t,{panel:true});
  const result=await runTerminal({baseUrl:web.baseUrl,steps:[...panelSteps,...uploadSteps,
    {wait:'确认提交 [yes/no]',send:'yes\n'},
    {wait:'AutoPanel 操作',count:2,send:'6\n'},{wait:'选择网盘编号',count:2,send:'1\n'},{wait:'选择空间',count:2,send:'1\n'},
    {wait:'目录操作',count:2,send:'1\n'},{wait:'目录操作',count:3,send:'1\n'},
    {wait:'确认提交 [yes/no]',count:2,send:'yes\n'},
    {wait:'AutoPanel 操作',count:3,send:'q\n'},{wait:'选择操作',count:2,send:'q\n'}]},t);
  verifyPanel(result);assert.ok(result.output.includes('已提交上传任务'));assert.ok(result.output.includes('已提交下载任务'));assert.ok(!result.output.includes('传输完成'));
  assert.deepEqual(web.transfers,[
    {path:'/autopanel/v1/netdisk/upload',body:{dst_path:'/',fsid:'fixture-disk',src_path:'/root/autodl-tmp/fixture-local.txt',file_id:'/',is_dir:false,drive_id:'resource-drive'}},
    {path:'/autopanel/v1/netdisk/download',body:{dst_path:'',fsid:'fixture-disk',src_path:'/fixture-cloud-folder/fixture-cloud-child.txt',file_id:'child-id',is_dir:false,download_url:'private-download-url-must-stay-hidden',file_size:10,drive_id:'resource-drive'}},
  ]);
  assert.ok(result.output.includes('/root/autodl-tmp/fixture-local.txt'));assert.ok(result.output.includes('/root/autodl-tmp/fixture-cloud-child.txt'));
});

test('terminal rejects existing upload and download targets without submitting an overwrite',{timeout:20000},async t=>{
  const web=await fixture(t,{panel:true,collision:true});
  const result=await runTerminal({baseUrl:web.baseUrl,steps:[...panelSteps,...uploadSteps,
    {wait:'AutoPanel 操作',count:2,send:'6\n'},{wait:'选择网盘编号',count:2,send:'1\n'},{wait:'选择空间',count:2,send:'1\n'},
    {wait:'目录操作',count:2,send:'1\n'},{wait:'目录操作',count:3,send:'1\n'},
    {wait:'AutoPanel 操作',count:3,send:'q\n'},{wait:'选择操作',count:2,send:'q\n'}]},t);
  verifyPanel(result);assert.equal((result.output.match(/FILE_EXISTS/g)||[]).length,2);assert.equal(web.transfers.length,0);
});


test('terminal explicitly selects recursive directories and confirms both transfer directions',{timeout:20000},async t=>{
 const web=await fixture(t,{panel:true,directory:true});
 const result=await runTerminal({baseUrl:web.baseUrl,steps:[...panelSteps,
 {wait:'AutoPanel 操作',send:'5\n'},{wait:'实例文件绝对路径',send:'/root/autodl-tmp/folder\n'},
 {wait:'选择网盘编号',send:'1\n'},{wait:'选择空间',send:'1\n'},{wait:'目录操作',send:'s\n'},
 {wait:'确认提交 [yes/no]',send:'yes\n'},
 {wait:'AutoPanel 操作',count:2,send:'6\n'},{wait:'选择网盘编号',count:2,send:'1\n'},{wait:'选择空间',count:2,send:'1\n'},
 {wait:'目录操作',count:2,send:'d 1\n'},{wait:'确认提交 [yes/no]',count:2,send:'yes\n'},
 {wait:'AutoPanel 操作',count:3,send:'q\n'},{wait:'选择操作',count:2,send:'q\n'}]},t);
 verifyPanel(result);assert.equal(web.transfers.length,2);assert.ok(web.transfers.every(x=>x.body.is_dir===true));assert.match(result.output,/递归目录/);
});
