import {createConnection} from 'node:net';import {pathToFileURL} from 'node:url';
export async function runRPC(socket){
let input='';for await(const chunk of process.stdin){input+=chunk;if(input.length>128*1024)throw new Error('请求过大');}
JSON.parse(input);
const conn=createConnection(socket);let response='';
const timer=setTimeout(()=>{console.error('服务器响应超时。若刚才已提交，请使用 result 查询；不要新建重复计划。');conn.destroy();process.exitCode=2;},180000);
conn.setEncoding('utf8');conn.on('connect',()=>conn.write(input.trim()+'\n'));
conn.on('data',data=>{response+=data;if(response.includes('\n')){clearTimeout(timer);process.stdout.write(response.slice(0,response.indexOf('\n'))+'\n');conn.end();}});
conn.on('error',e=>{clearTimeout(timer);console.error('Fo 服务不可用：'+e.message);process.exitCode=2;});
conn.on('end',()=>{clearTimeout(timer);if(!response){console.error('Fo 控制连接意外关闭，请查询任务状态');process.exitCode=2;}});
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)await runRPC('/var/lib/fo-autodl/control.sock');
