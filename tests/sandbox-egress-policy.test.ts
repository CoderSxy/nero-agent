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

test('dual-stack public DNS chooses IPv4 without allowing IPv6 egress or mixed-private answers',async()=>{
 const result=await resolvePublicTarget('pypi.org',443,async()=>[{address:'151.101.0.223',family:4},{address:'2a04:4e42::223',family:6}]);
 assert.equal(result.address,'151.101.0.223');
 await assert.rejects(()=>resolvePublicTarget('example.com',443,async()=>[{address:'8.8.8.8',family:4},{address:'::1',family:6}]));
});
