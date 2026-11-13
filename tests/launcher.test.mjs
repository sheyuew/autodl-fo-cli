import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join,resolve} from 'node:path';import {spawnSync} from 'node:child_process';
const quote=value=>"'"+value.replace(/'/g,"'\\''")+"'";
async function fixture(t,version){
 const dir=await mkdtemp(join(tmpdir(),'fo launcher '));t.after(()=>rm(dir,{recursive:true,force:true}));
 const preload=join(dir,'version.cjs');await writeFile(preload,"Object.defineProperty(process.versions,'node',{value:process.env.FO_TEST_NODE_VERSION});\n");
 const node=join(dir,'node');await writeFile(node,`#!/bin/sh\nif [ "$1" = --version ]; then printf 'v%s\\n' "$FO_TEST_NODE_VERSION"; exit 0; fi\nexec ${quote(process.execPath)} --require ${quote(preload)} "$@"\n`,{mode:0o755});
 return {node,run:()=>spawnSync('/bin/bash',[resolve('fo'),'help'],{encoding:'utf8',env:{...process.env,PATH:dir+':'+process.env.PATH,FO_TEST_NODE_VERSION:version,FO_CLI_HOME:join(dir,'settings')},timeout:10000})};
}
test('launcher accepts Node 20.17 from PATH and reaches the real CLI without network access',async t=>{
 const f=await fixture(t,'20.17.0'),p=f.run();assert.equal(p.status,0,p.stderr);assert.match(p.stdout,/fo http/);
});
test('launcher rejects an unsupported Node and identifies the actual version and executable',async t=>{
 const f=await fixture(t,'20.16.0'),p=f.run();assert.notEqual(p.status,0);assert.ok(p.stderr.includes('v20.16.0'),p.stderr);assert.ok(p.stderr.includes(f.node),p.stderr);assert.ok(!p.stdout.includes('fo http'));
});
