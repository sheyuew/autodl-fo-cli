import {dirname,join} from 'node:path';import {readJSON,writeJSON} from './storage.mjs';
export class Accounts{
  constructor(configPath){this.configPath=configPath;this.path=join(dirname(configPath),'accounts.json');}
  async list(){return (await readJSON(this.path,{accounts:[]})).accounts;}
  async remember({account,username,config}){
    if(typeof account!=='string'||!account||typeof username!=='string'||!username)throw new Error('账号信息无效');
    const rows=(await this.list()).filter(x=>!(x.account.startsWith('connection:')&&x.config.host===config.host)),row={account,username,config},index=rows.findIndex(x=>x.account===account);
    if(index<0)rows.push(row);else rows[index]=row;await writeJSON(this.path,{accounts:rows});
  }
  async select(username){
    const rows=await this.list(),matches=rows.filter(x=>x.username===username||x.account===username);
    if(matches.length!==1)throw new Error('没有找到唯一匹配的账号，请从账号列表选择');
    await writeJSON(this.configPath,matches[0].config);return matches[0].config;
  }
}
