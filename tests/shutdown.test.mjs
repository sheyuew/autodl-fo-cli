import test from 'node:test';
import assert from 'node:assert/strict';
import {closeBrowser} from '../lib/shutdown.mjs';

test('service shutdown asks Chrome to save its profile before exiting',async()=>{
  const calls=[];await closeBrowser({call:async(method)=>{calls.push(method);}}, {kill:sig=>calls.push(sig)});
  assert.deepEqual(calls,['Browser.close']);
});
test('broken browser pipe falls back to terminating the child',async()=>{
  const calls=[];await closeBrowser({call:async()=>{throw new Error('pipe closed');}}, {kill:sig=>calls.push(sig)});
  assert.deepEqual(calls,['SIGTERM']);
});
