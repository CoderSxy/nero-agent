import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SandboxManager } from '../src/mastra/sandbox/manager';
import { FakeSandboxProvider } from '../src/mastra/sandbox/fake-provider';
import { authContextFromUser } from '../src/mastra/auth/auth-context';
import { sandboxTools } from '../src/mastra/sandbox/tool';
import { getSandboxRuntimeConfig } from '../src/mastra/sandbox/runtime-config';
const auth = authContextFromUser({id:'11111111-1111-4111-8111-111111111111', email:'x@example.test',displayName:'x',roles:['user']});
test('bash executes complete syntax with server-owned thread cwd and rejects invalid input', async () => {
 process.env.WORKSPACE_ROOT=await mkdtemp(join(tmpdir(),'bash-test-'));
 Object.assign(process.env,{SANDBOX_COMMANDS_ENABLED:'true',SANDBOX_BASH_ENABLED:'true',SANDBOX_FILE_WRITE_ENABLED:'true',WORKSPACE_HOST_QUOTA_VERIFIED:'true'});
 const provider=new FakeSandboxProvider();
 const manager=new SandboxManager(provider,{getThreadById:async({threadId})=>({id:threadId,resourceId:auth.userId})});
 const script='value="a b"; printf "%s" "$value" | cat > result.txt\necho done';
 await manager.executeBash({auth,threadId:'bash-thread',script});
 assert.equal(provider.lastCommand,'bash');
 assert.deepEqual(provider.lastArgs,['--noprofile','--norc','-c',script]);
 assert.equal(provider.lastOptions?.cwd,'/workspace/threads/bash-thread');
 for(const bad of ['', 'x\0y', 'x'.repeat(65537)]) await assert.rejects(()=>manager.executeBash({auth,threadId:'bash-thread',script:bad}));
 process.env.SANDBOX_BASH_ENABLED='false';
 await assert.rejects(()=>manager.executeBash({auth,threadId:'bash-thread',script:'true'}),/disabled/i);
});
test('runtime config defaults offline and fails closed for invalid public configuration',()=>{
 delete process.env.SANDBOX_NETWORK_MODE;
 assert.equal(getSandboxRuntimeConfig().networkMode,'none');
 process.env.SANDBOX_NETWORK_MODE='bridge';
 assert.throws(()=>getSandboxRuntimeConfig(),/network/i);
 process.env.SANDBOX_NETWORK_MODE='public-http'; delete process.env.SANDBOX_EGRESS_IMAGE;
 assert.throws(()=>getSandboxRuntimeConfig(),/image/i);
 process.env.SANDBOX_EGRESS_IMAGE='proxy@sha256:'+'a'.repeat(64);
 assert.equal(getSandboxRuntimeConfig().networkMode,'public-http');
 delete process.env.SANDBOX_NETWORK_MODE;
});

test('Bash tool shares all sandbox exposure gates and rejects other thread owners',async()=>{
 Object.assign(process.env,{SANDBOX_COMMANDS_ENABLED:'true',SANDBOX_BASH_ENABLED:'true',SANDBOX_PROVIDER:'docker',SANDBOX_FILE_WRITE_ENABLED:'true',WORKSPACE_HOST_QUOTA_VERIFIED:'true'});
 assert.ok('execute_bash' in sandboxTools());
 process.env.SANDBOX_BASH_ENABLED='false';assert.ok(!('execute_bash' in sandboxTools()));
 process.env.SANDBOX_BASH_ENABLED='true';process.env.WORKSPACE_HOST_QUOTA_VERIFIED='false';assert.deepEqual(sandboxTools(),{});
 process.env.WORKSPACE_HOST_QUOTA_VERIFIED='true';
 const provider=new FakeSandboxProvider();const manager=new SandboxManager(provider,{getThreadById:async()=>({id:'foreign',resourceId:'22222222-2222-4222-8222-222222222222'})});
 await assert.rejects(()=>manager.executeBash({auth,threadId:'foreign',script:'echo nope'}));assert.equal(provider.executeCalls,0);
 await assert.rejects(()=>manager.executeBash({auth,threadId:'bash-thread',script:'中'.repeat(30000)}),/64KiB/);
});
