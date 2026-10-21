import test from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate as nextTurn} from 'node:timers/promises';
import {commandQueue} from '../src/mastra/sandbox/execution-queue';
import {SandboxRegistry} from '../src/mastra/sandbox/registry';
import {DockerSandboxProvider} from '../src/mastra/sandbox/docker/provider';
const userId='11111111-1111-4111-8111-111111111111';const owner={userId,sandboxId:'sb_'+userId};const root='/tmp/provision-review/users/'+userId+'/workspace';
function setup(running=0){
 delete process.env.DATABASE_URL;
 Object.assign(process.env,{SANDBOX_NETWORK_MODE:'public-http',SANDBOX_EGRESS_IMAGE:'proxy@sha256:'+'a'.repeat(64),SANDBOX_IMAGE:'runtime@sha256:'+'b'.repeat(64),SANDBOX_MAX_CONCURRENT:'2',WORKSPACE_ROOT:'/tmp/provision-review'});
 const state={ensures:0,cleanups:0,removed:[] as string[],containers:new Map<string,any>()};
 const networks:any={ensure:async()=>{state.ensures++;return{networkId:'inside',proxyUrl:'http://proxy:3128',fingerprint:'fp'}},removeIdle:async()=>{state.cleanups++}};
 const engine:any={findLabeled:async(label:string)=>label==='nero.sandbox'?Array.from({length:running},()=>({State:{Running:true}})):[],inspect:async(id:string)=>state.containers.get(id)??null,create:async(options:any)=>{state.containers.set('new',{Id:'new',Config:options,HostConfig:options.HostConfig});return{id:'new'}},start:async()=>{throw new Error('start failed')},remove:async(id:string)=>{state.removed.push(id);state.containers.delete(id)}};
 const registry=new SandboxRegistry();return{state,engine,networks,registry,provider:new DockerSandboxProvider(engine,registry,networks)};
}
test('capacity rejection happens before creating any egress resources',async()=>{
 const {provider,state}=setup(2);await assert.rejects(()=>provider.ensureRunning(owner,root),/limit/);assert.equal(state.ensures,0);
});
test('container startup failure rolls back container, registry and unused egress',async()=>{
 const {provider,state,registry}=setup();await assert.rejects(()=>provider.ensureRunning(owner,root),/start failed/);await nextTurn();await nextTurn();
 assert.deepEqual(state.removed,['new']);assert.equal((await registry.getByUser(userId))?.containerId,undefined);assert.ok(state.cleanups>0);
});
test('partial egress provisioning failure also schedules unused resource cleanup',async()=>{
 const {provider,state,networks}=setup();networks.ensure=async()=>{state.ensures++;throw new Error('proxy failed')};await assert.rejects(()=>provider.ensureRunning(owner,root),/proxy failed/);await nextTurn();await nextTurn();assert.ok(state.cleanups>0);
});

test('egress rollback waits until the failing command releases its queue entry',async()=>{
 const {provider,networks}=setup();const busy:boolean[]=[];
 networks.removeIdle=async()=>{busy.push(commandQueue.isUserBusy(userId))};
 await assert.rejects(()=>commandQueue.run(userId,'rollback',()=>provider.ensureRunning(owner,root)),/start failed/);
 await nextTurn();await nextTurn();assert.deepEqual(busy,[false]);
});
