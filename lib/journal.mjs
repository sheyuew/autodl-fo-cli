import {mkdir,open,rename,readFile} from 'node:fs/promises';
import {join} from 'node:path';
export class Journal {
  constructor(dir){this.dir=dir;}
  path(id){if(!/^[0-9a-f-]{36}$/.test(id))throw new Error('无效计划 ID');return join(this.dir,id+'.json');}
  async get(id){return JSON.parse(await readFile(this.path(id),'utf8'));}
  async put(plan){
    const dest=this.path(plan.id);await mkdir(this.dir,{recursive:true,mode:0o700});
    const temp=dest+'.tmp';const f=await open(temp,'w',0o600);
    try{await f.writeFile(JSON.stringify(plan,null,2));await f.sync();}finally{await f.close();}
    await rename(temp,dest);
    const dir=await open(this.dir,'r');try{await dir.sync();}finally{await dir.close();}
    return plan;
  }
}
