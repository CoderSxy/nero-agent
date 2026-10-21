import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,symlink} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {materializeSkillExecution} from '../src/mastra/skills/materialize';
import {reportSkillRuntimeCompatibility} from '../src/mastra/skills/runtime';
test('skill resources preserve structure, repair tampering and reject symlink escape',async()=>{
 const root=await mkdtemp(join(tmpdir(),'skill-copy-'));const release=join(root,'release');const task=join(root,'task');await mkdir(join(release,'scripts'),{recursive:true});await mkdir(task);
 await writeFile(join(release,'scripts/main.mjs'),'export default 1');await writeFile(join(release,'SKILL.md'),'skill');
 const input={pin:{skillId:'11111111-1111-4111-8111-111111111111',name:'demo',version:1,manifestHash:'a'.repeat(64)},verifiedReleaseRoot:release,taskHostRoot:task,taskContainerRoot:'/workspace/threads/t'};
 const result=await materializeSkillExecution(input);
 assert.match(result.containerRoot,/package$/);assert.equal(await readFile(result.hostRoot+'/scripts/main.mjs','utf8'),'export default 1');
 await writeFile(result.hostRoot+'/scripts/main.mjs','tampered');await materializeSkillExecution(input);assert.equal(await readFile(result.hostRoot+'/scripts/main.mjs','utf8'),'export default 1');
 await symlink(release,join(task,'.runtime','escape'));await assert.rejects(()=>materializeSkillExecution({...input,taskHostRoot:join(task,'.runtime','escape')}));
});
test('public skill reports missing platform network until enabled, never falls back',()=>{
 const manifest={schemaVersion:1 as const,runtimes:['python3' as const],entrypoints:['scripts/main.py'],requiredTools:[],network:'public' as const};
 assert.equal(reportSkillRuntimeCompatibility(manifest,{registeredToolIds:[],publicNetworkAvailable:false}),'network-unavailable');
 assert.equal(reportSkillRuntimeCompatibility(manifest,{registeredToolIds:[],publicNetworkAvailable:true}),'ready');
});

test('Node skill keeps its own CommonJS scope inside a module task and preserves declared ESM',async()=>{
 const root=await mkdtemp(join(tmpdir(),'skill-scope-'));const release=join(root,'release'),task=join(root,'task');await mkdir(release);await mkdir(task);
 await writeFile(join(task,'package.json'),JSON.stringify({type:'module'}));await writeFile(join(release,'main.js'),"console.log(typeof require('node:path').join)");
 const input={pin:{skillId:'11111111-1111-4111-8111-111111111111',name:'demo',version:1,manifestHash:'b'.repeat(64)},verifiedReleaseRoot:release,taskHostRoot:task,taskContainerRoot:'/workspace/threads/t'};
 let result=await materializeSkillExecution(input);
 assert.equal(execFileSync(process.execPath,[result.hostRoot+'/main.js'],{encoding:'utf8'}).trim(),'function');
 await writeFile(join(release,'package.json'),JSON.stringify({type:'module'}));await writeFile(join(release,'main.js'),"import path from 'node:path'; console.log(typeof path.join)");
 result=await materializeSkillExecution(input);assert.equal(execFileSync(process.execPath,[result.hostRoot+'/main.js'],{encoding:'utf8'}).trim(),'function');
});

test('package metadata does not follow links and ambiguous js preserves Node syntax detection',async()=>{
 const root=await mkdtemp(join(tmpdir(),'skill-scope-safe-')),release=join(root,'release'),task=join(root,'task');await mkdir(release);await mkdir(task);
 const pin={skillId:'11111111-1111-4111-8111-111111111111',name:'demo',version:1,manifestHash:'c'.repeat(64)};
 const input={pin,verifiedReleaseRoot:release,taskHostRoot:task,taskContainerRoot:'/workspace/threads/t'};
 await writeFile(join(task,'package.json'),JSON.stringify({type:'commonjs'}));await writeFile(join(release,'main.js'),"import path from 'node:path'; console.log(typeof path.join)");
 const result=await materializeSkillExecution(input);
 const victim=join(root,'victim');await writeFile(victim,'unchanged');
 const metadata=join(result.hostRoot,'..','package.json');const {rm}=await import('node:fs/promises');await rm(metadata);await symlink(victim,metadata);
 await materializeSkillExecution(input);assert.equal(await readFile(victim,'utf8'),'unchanged');
 assert.equal(execFileSync(process.execPath,[result.hostRoot+'/main.js'],{encoding:'utf8'}).trim(),'function');
});

test('public skill still requires its declared platform tools',()=>{
 const manifest={schemaVersion:1 as const,runtimes:['python3' as const],entrypoints:['scripts/main.py'],requiredTools:['web_search'],network:'public' as const};
 assert.equal(reportSkillRuntimeCompatibility(manifest,{registeredToolIds:[],publicNetworkAvailable:true}),'missing-tools');
 assert.equal(reportSkillRuntimeCompatibility(manifest,{registeredToolIds:['web_search'],publicNetworkAvailable:true}),'ready');
});
