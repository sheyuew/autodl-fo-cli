import {spawn} from 'node:child_process';import {once} from 'node:events';import {fileURLToPath} from 'node:url';
const driver=`import os,pty,subprocess,select,time,sys,json
payload=json.loads(sys.stdin.readline())
steps=payload['steps']
master,slave=pty.openpty()
env=dict(os.environ,AUTODL_WEB_ORIGIN=sys.argv[3])
env.update(payload.get('env',{}))
p=subprocess.Popen([sys.argv[1],sys.argv[2]]+payload.get('args',[]),stdin=slave,stdout=slave,stderr=slave,env=env,close_fds=True)
os.close(slave)
captured=b''
def read_once():
 global captured
 if select.select([master],[],[],0.1)[0]:
  try:part=os.read(master,65536)
  except OSError:return False
  if not part:return False
  captured+=part
 return True
try:
 for step in steps:
  end=time.monotonic()+float(sys.argv[4])
  marker=step['wait'].encode()
  while captured.count(marker)<step.get('count',1):
   if time.monotonic()>end:raise RuntimeError('terminal prompt timeout')
   if not read_once():raise RuntimeError('terminal closed before expected prompt')
  os.write(master,step['send'].encode())
 end=time.monotonic()+float(sys.argv[4])
 while p.poll() is None:
  if time.monotonic()>end:raise RuntimeError('terminal exit timeout')
  if not read_once():break
 p.wait(timeout=2)
 while select.select([master],[],[],0)[0]:
  if not read_once():break
 sys.stdout.buffer.write(captured)
 sys.exit(p.returncode)
finally:
 if p.poll() is None:p.kill();p.wait()
 os.close(master)
`;
export async function runTerminal({steps,args=[],env={},baseUrl='https://www.autodl.com',timeoutSeconds=8},t){
  const child=spawn('python3',['-c',driver,process.execPath,fileURLToPath(new URL('../cli.mjs',import.meta.url)),baseUrl,String(timeoutSeconds)],{stdio:['pipe','pipe','pipe']});
  t?.after(()=>{if(child.exitCode===null)child.kill('SIGTERM');});
  let output='',error='';child.stdout.on('data',x=>output+=x);child.stderr.on('data',x=>error+=x);child.stdin.end(JSON.stringify({steps,args,env})+'\n');
  const [code]=await once(child,'exit');return {code,output,error};
}
