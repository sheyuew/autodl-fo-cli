import test from 'node:test';import assert from 'node:assert/strict';
const loaded=await import('../remote-client.mjs').catch(e=>{if(e.code==='ERR_MODULE_NOT_FOUND')return {};throw e;});
function client(request){assert.equal(typeof loaded.RemoteClient,'function','SSH HTTP client has not been implemented');return new loaded.RemoteClient({request});}

test('remote login keeps only the returned verified identity, and sends the password only in the request body',async()=>{
 const seen=[],c=client(async q=>{seen.push(q);return {identity:{id:'one',username:'alice@team',subaccount:true},state:'authenticated'};});
 await c.login('alice@team','fixture-password');assert.equal(c.identity.username,'alice@team');assert.deepEqual(seen,[{op:'login-password',username:'alice@team',password:'fixture-password'}]);assert.ok(!JSON.stringify(c).includes('fixture-password'));
});
test('remote catalog and panel reads refer only to their current server handle',async()=>{
 const seen=[],c=client(async q=>{seen.push(q);return q.op==='panel-open'?{handle:'private-handle'}:[];});
 await c.instances();await c.regions();const panel=await c.openPanel('instance-one');await panel.localFiles('/root/a');await panel.cloudFiles({account:{fs_id:'disk-one'},path:'/folder',fileId:'parent',source:'backup'});
 assert.deepEqual(seen,[{op:'instances'},{op:'regions'},{op:'panel-open',instanceUuid:'instance-one'},{op:'panel-read',handle:'private-handle',query:'localFiles',path:'/root/a'},{op:'panel-cloud',handle:'private-handle',diskId:'disk-one',args:{path:'/folder',fileId:'parent',source:'backup'}}]);
});
test('remote downloads send identifiers and confirmation while leaving signed URL resolution on the server',async()=>{
 const seen=[],c=client(async q=>{seen.push(q);return q.op==='panel-open'?{handle:'h'}:{accepted:true};});const panel=await c.openPanel('instance-one');
 await panel.download({account:{fs_id:'d',user_info:{access_token:'must-not-send'}},file:{file_id:'f',name:'file.bin',download_url:'must-not-send'},parentFileId:'parent',remoteDirectory:'/folder',source:'resource',confirmed:true});
 assert.deepEqual(seen[1],{op:'panel-transfer',handle:'h',direction:'download',diskId:'d',source:'resource',remoteDirectory:'/folder',parentFileId:'parent',fileId:'f',fileName:'file.bin',confirmed:true});assert.ok(!JSON.stringify(seen).includes('must-not-send'));
});


test('remote instance management sends only explicit operations and server-issued plan identifiers',async()=>{
 const seen=[],c=client(async q=>{seen.push(q);return q.op==='instance-prepare'?{id:'p'}:{};});
 assert.equal(typeof c.prepareInstance,'function');await c.instanceInfo('one');await c.connection('one');await c.monitor('one');await c.images();const p=await c.prepareInstance('rename','one',{name:'new'});await c.executeInstance(p.id,{confirmed:true});
 assert.deepEqual(seen,[{op:'instance-info',instanceUuid:'one'},{op:'instance-connection',instanceUuid:'one',includeSecrets:false,confirmed:false},{op:'instance-monitor',instanceUuid:'one'},{op:'images'},{op:'instance-prepare',instanceUuid:'one',action:'rename',args:{name:'new'}},{op:'instance-execute',planId:'p',confirmed:true}]);
});
