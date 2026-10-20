import test from 'node:test';
import assert from 'node:assert/strict';
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
