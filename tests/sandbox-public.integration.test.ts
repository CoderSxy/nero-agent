import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,chmod,rm,readFile,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {createDockerodeEngine} from '../src/mastra/sandbox/docker/client';
import {DockerSandboxProvider} from '../src/mastra/sandbox/docker/provider';
import {SandboxRegistry} from '../src/mastra/sandbox/registry';
import {SandboxManager} from '../src/mastra/sandbox/manager';
import {sandboxNetworkManager} from '../src/mastra/sandbox/network/manager';
import {authContextFromUser} from '../src/mastra/auth/auth-context';
import {ensureThreadDirectory} from '../src/mastra/workspace/manager';
import {createSkillScriptRunner} from '../src/mastra/skills/script-runner';
import type {SkillRuntimeManifest} from '../src/mastra/skills/types';
const enabled=process.env.SANDBOX_PUBLIC_INTEGRATION==='true';
const offline=process.env.SANDBOX_RUNTIME_INTEGRATION==='true';
const egress=process.env.SANDBOX_EGRESS_INTEGRATION==='true';
const localPackages=offline||egress;
test('live Docker: Bash, public-only HTTP, task pip/npm and skill Python/CJS/ESM reuse',{skip:!enabled&&!offline&&!egress,timeout:300000},async(t)=>{
 assert.match(process.env.SANDBOX_IMAGE??'',/@sha256:/);assert.match(process.env.SANDBOX_EGRESS_IMAGE??'',/@sha256:/);
 delete process.env.DATABASE_URL;
 Object.assign(process.env,{SANDBOX_NETWORK_MODE:offline?'none':'public-http',SANDBOX_BASH_ENABLED:'true',SANDBOX_DEPENDENCIES_ENABLED:'true',SANDBOX_COMMANDS_ENABLED:'true',SANDBOX_FILE_WRITE_ENABLED:'true',WORKSPACE_HOST_QUOTA_VERIFIED:'true',SANDBOX_PROVIDER:'docker',AGENT_SKILLS_ENABLED:'true',SKILL_SCRIPT_EXECUTION_ENABLED:'true'});
 const root=await mkdtemp(join(tmpdir(),'nero-public-live-'));process.env.WORKSPACE_ROOT=join(root,'workspace');process.env.SKILLS_STORAGE_ROOT=join(root,'skills');
 const userId=randomUUID(),threadId='live-public';const owner={userId,sandboxId:'sb_'+userId};
 const auth=authContextFromUser({id:userId,email:'live@example.test',displayName:'live',roles:['user']});
 const lookup={getThreadById:async({threadId:id}:{threadId:string})=>id===threadId?{id,resourceId:userId}:null};
 const task=await ensureThreadDirectory(auth,threadId,lookup);await chmod(task.hostPath,0o777);
 const engine=await createDockerodeEngine();const networks=await sandboxNetworkManager();const registry=new SandboxRegistry();const provider=new DockerSandboxProvider(engine,registry,networks);const manager=new SandboxManager(provider,lookup);
 t.after(async()=>{await provider.remove(owner);await networks.removeIdle(owner);await rm(root,{recursive:true,force:true})});
 const run=async(script:string)=>{const result=await manager.executeBash({auth,threadId,script});assert.equal(result.exitCode,0,result.stderr+'\n'+result.stdout);return result};
 await run('value="hello world"; printf "%s" "$value" | tr a-z A-Z > bash.txt');assert.equal(await readFile(join(task.hostPath,'bash.txt'),'utf8'),'HELLO WORLD');
 assert.equal((await manager.executeBash({auth,threadId,script:'exit 7'})).exitCode,7);
 if(!offline){
 await run('if curl --noproxy "*" --max-time 3 https://1.1.1.1/ >/dev/null 2>&1; then exit 9; fi');
 for(const url of ['http://127.0.0.1/','http://169.254.169.254/','http://10.0.0.1/','http://host.docker.internal/'])await run(`test "$(curl --max-time 5 -s -o /dev/null -w '%{http_code}' '${url}')" = 403`);
 t.diagnostic('Public proxy rejected internal/metadata/host targets; direct egress disabled');
 if(!egress)await run('curl --fail --max-time 25 https://pypi.org/simple/colorama/ > /dev/null');
 }
 if(localPackages){
  await run(`python -c 'import zipfile; z=zipfile.ZipFile("local_demo-1.0-py3-none-any.whl","w"); z.writestr("local_demo.py","value=42\\n"); z.writestr("local_demo-1.0.dist-info/METADATA","Metadata-Version: 2.1\\nName: local-demo\\nVersion: 1.0\\n"); z.writestr("local_demo-1.0.dist-info/WHEEL","Wheel-Version: 1.0\\nGenerator: test\\nRoot-Is-Purelib: true\\nTag: py3-none-any\\n"); z.writestr("local_demo-1.0.dist-info/RECORD",""); z.close()'`);
  await run('python -m pip install --no-index ./local_demo-1.0-py3-none-any.whl');
  await run('python -c "import local_demo; assert local_demo.value==42"');
  await run(`mkdir -p local-node; printf '%s' '{"name":"is-number","version":"7.0.0","main":"index.cjs"}' > local-node/package.json; printf '%s' 'module.exports = x => typeof x === "number";' > local-node/index.cjs; npm install --no-audit --no-fund ./local-node`);
 }else{
 await run('python -m pip install --disable-pip-version-check colorama==0.4.6 requests==2.32.5');
 await run('python -c "import colorama,requests; assert requests.get(\'https://pypi.org/simple/colorama/\',timeout=20).status_code==200; print(colorama.__version__)"');
 await run('npm install --no-audit --no-fund is-number@7.0.0');
 }
 await run('node -e "if(!require(\'is-number\')(42))process.exit(1)"');
 const skillId=randomUUID(),hash='a'.repeat(64);const releaseRoot=join(process.env.SKILLS_STORAGE_ROOT,'releases',skillId,'1',hash);await mkdir(join(releaseRoot,'scripts'),{recursive:true});
 await writeFile(join(releaseRoot,'SKILL.md'),'---\nname: demo\ndescription: demo\n---\nDemo');
 await writeFile(join(releaseRoot,'scripts/main.py'),localPackages?'import local_demo; print(local_demo.value)':'import colorama; print(colorama.__version__)');
 await writeFile(join(releaseRoot,'scripts/main.cjs'),"console.log(require('is-number')(42))");
 await writeFile(join(releaseRoot,'scripts/main.mjs'),"import isNumber from 'is-number'; console.log(isNumber(42))");
 const pin={skillId,name:'demo',version:1,manifestHash:hash};let manifest:SkillRuntimeManifest={schemaVersion:1,runtimes:['python3','node'],entrypoints:['scripts/main.py','scripts/main.cjs','scripts/main.mjs'],requiredTools:[],network:offline?'none':'public'};
 const runner=createSkillScriptRunner({engine,lookup,imageDigest:process.env.SANDBOX_IMAGE!,resolve:async()=>({ok:true,skill:pin,data:{pin,releaseRoot,runtimeManifest:manifest}})});
 const context={serverExecutionId:randomUUID(),auth,threadId,pins:new Map()};
 for(const script of manifest.entrypoints){const result=await runner.execute(context,{skillName:'demo',path:script});assert.equal(result.ok,true);if(result.ok)assert.equal(result.data.exitCode,0,result.data.stderr)}
 const resources=await runner.prepareResources!(context,'demo');assert.equal(resources.ok,true);
 if(resources.ok)await run(`python '${resources.data.containerPath}/scripts/main.py'`);
 await writeFile(join(releaseRoot,'scripts/offline.py'),'import urllib.request\ntry:\n urllib.request.urlopen("https://pypi.org",timeout=3)\nexcept Exception:\n print("offline")\nelse:\n raise RuntimeError("unexpected egress")');
 manifest={...manifest,network:'none',entrypoints:['scripts/offline.py']};const offlineResult=await runner.execute(context,{skillName:'demo',path:'scripts/offline.py'});assert.equal(offlineResult.ok,true);if(offlineResult.ok)assert.equal(offlineResult.data.exitCode,0,offlineResult.data.stderr);
 await run('if touch /platform-root-write 2>/dev/null; then exit 9; fi');
 const controller=new AbortController();
 const cancelled=manager.executeBash({auth,threadId,script:'touch cancel-started; sleep 30; touch cancel-finished',abortSignal:controller.signal});
 // Attach rejection handler before abort so Node does not treat cancellation as unhandled.
 const cancelCheck=assert.rejects(cancelled,/abort|cancel/i);
 for(let attempts=0;attempts<100;attempts++){
  try{await access(join(task.hostPath,'cancel-started'));break}catch{await new Promise(r=>setTimeout(r,50))}
 }
 await access(join(task.hostPath,'cancel-started'));controller.abort();await cancelCheck;
 await assert.rejects(()=>access(join(task.hostPath,'cancel-finished')));
 await run('echo restart-after-cancel');
 process.env.SANDBOX_COMMAND_TIMEOUT_MS='100';
 await assert.rejects(()=>manager.executeBash({auth,threadId,script:'sleep 10'}),/timed out/i);
 process.env.SANDBOX_COMMAND_TIMEOUT_MS='120000';
 await run('echo restart-after-timeout');
 t.diagnostic('Read-only root, in-flight cancellation, timeout and subsequent restart verified');

});
