import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,readdir,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {execFileSync} from 'node:child_process';
import {prepareTaskRuntime,taskRuntimePaths} from '../src/mastra/sandbox/task-runtime';
test('task env persists dependencies by thread, explicitly passes proxy without server secrets',async()=>{
 const calls:any[]=[];const execute=async(...args:any[])=>{calls.push(args);return{exitCode:0,stdout:'',stderr:''}};
 const a=await prepareTaskRuntime({execute,cwd:'/workspace/threads/a',imageDigest:'image-a',dependenciesEnabled:true,proxyUrl:'http://proxy:3128'});
 assert.ok(a.env.includes('HOME=/workspace/threads/a/.runtime/home'));
 assert.ok(a.env.some(s=>s.startsWith('PATH=/workspace/threads/a/.runtime/venv/bin:')));
 assert.ok(a.env.includes('HTTPS_PROXY=http://proxy:3128'));assert.ok(!a.env.some(s=>s.startsWith('DATABASE_URL=')));
 assert.equal(a.python,'/workspace/threads/a/.runtime/venv/bin/python');
 assert.notDeepEqual(taskRuntimePaths('/workspace/threads/a'),taskRuntimePaths('/workspace/threads/b'));
 assert.throws(()=>taskRuntimePaths('/etc'));
 assert.ok(calls.length>0);
 await assert.rejects(()=>prepareTaskRuntime({execute:async()=>({exitCode:1,stdout:'',stderr:'quota'}),cwd:'/workspace/threads/a',imageDigest:'x',dependenciesEnabled:true}),/quota/);
});

test('actual bootstrap repairs interrupted venv and quarantines dependencies on image/ABI identity change',async()=>{
 const root=await mkdtemp(join(tmpdir(),'task-bootstrap-'));const runtime=join(root,'.runtime');
 await mkdir(join(runtime,'venv'),{recursive:true});await writeFile(join(runtime,'venv','partial'),'interrupted');
 const execute=async(_command:string,args:string[])=>{
  try{const stdout=execFileSync('python3',[args[0],args[1],runtime,...args.slice(3)],{encoding:'utf8',env:{...process.env,PATH:dirname(process.execPath)+':'+process.env.PATH}});return{exitCode:0,stdout,stderr:''}}catch(e:any){return{exitCode:1,stdout:e.stdout??'',stderr:e.stderr??String(e)}}
 };
 await prepareTaskRuntime({execute,cwd:'/workspace/threads/a',imageDigest:'image-a',dependenciesEnabled:true});
 await access(join(runtime,'venv','bin','python'));await assert.rejects(()=>access(join(runtime,'venv','partial')));
 await mkdir(join(root,'node_modules'));await writeFile(join(root,'node_modules','old-native.node'),'old ABI');await mkdir(join(runtime,'node'),{recursive:true});
 const changed=await prepareTaskRuntime({execute,cwd:'/workspace/threads/a',imageDigest:'image-b',dependenciesEnabled:true});
 await assert.rejects(()=>access(join(root,'node_modules')));
 assert.ok((await readdir(root)).some(p=>p.startsWith('node_modules.incompatible-')));
 assert.ok(changed.warnings?.some(s=>s.includes('npm install')));
});
