import test from 'node:test';
import assert from 'node:assert/strict';
import { resolvePublicTarget } from '../src/mastra/sandbox/network/policy';
test('public-only policy rejects non-global targets, IPv6, mixed DNS, credentials and bad ports',async()=>{
 for (const host of ['127.0.0.1','10.0.0.1','169.254.169.254','172.16.0.1','192.168.0.1','0.0.0.0','100.64.0.1','198.18.0.1','224.0.0.1','::1','::ffff:8.8.8.8','user@example.com','2130706433','localhost']) {
  await assert.rejects(()=>resolvePublicTarget(host,443,async()=>[{address:'127.0.0.1',family:4}]));
 }
 await assert.rejects(()=>resolvePublicTarget('example.com',22));
 await assert.rejects(()=>resolvePublicTarget('example.com',443,async()=>[{address:'8.8.8.8',family:4},{address:'10.0.0.1',family:4}]));
 const target=await resolvePublicTarget('example.com',443,async()=>[{address:'8.8.8.8',family:4}]);
 assert.deepEqual(target,{address:'8.8.8.8',family:4,hostname:'example.com',port:443});
});
