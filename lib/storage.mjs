import {mkdir,open,rename,readFile} from 'node:fs/promises';
import {dirname} from 'node:path';
export async function readJSON(path,fallback){
  try{return JSON.parse(await readFile(path,'utf8'));}catch(e){if(e.code==='ENOENT')return structuredClone(fallback);throw e;}
}
export async function writeJSON(path,value){
  await mkdir(dirname(path),{recursive:true,mode:0o700});
  const temp=path+'.tmp',f=await open(temp,'w',0o600);
  try{await f.writeFile(JSON.stringify(value,null,2));await f.sync();}finally{await f.close();}
  await rename(temp,path);
  const dir=await open(dirname(path),'r');try{await dir.sync();}finally{await dir.close();}
  return value;
}
