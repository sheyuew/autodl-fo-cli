import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,symlink} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {fileURLToPath} from 'node:url';import {execFileSync} from 'node:child_process';
test('release symlinks still execute the server help entry point',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'fo-release-')),link=join(dir,'server.mjs');await symlink(fileURLToPath(new URL('../http-server.mjs',import.meta.url)),link);
 assert.match(execFileSync(process.execPath,[link,'--help'],{encoding:'utf8'}),/HTTP/);
});
