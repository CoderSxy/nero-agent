import test from 'node:test';
import assert from 'node:assert/strict';
import { SandboxNetworkManager } from '../src/mastra/sandbox/network/manager';
import { dockerSandboxCreateOptions,validateDockerCreateConfig } from '../src/mastra/sandbox/docker/config';
const owner={userId:'11111111-1111-4111-8111-111111111111',sandboxId:'s'};
test('network manager builds isolated no-gateway task network and dual-network proxy; no fallback',async()=>{
 Object.assign(process.env,{SANDBOX_NETWORK_MODE:'public-http',SANDBOX_EGRESS_IMAGE:'egress@sha256:'+'a'.repeat(64),SANDBOX_IMAGE:'sandbox@sha256:'+'b'.repeat(64),WORKSPACE_ROOT:'/tmp/net-test'});
 const nets:any[]=[];const containers:any[]=[];
 const engine:any={findLabeled:async()=>containers,create:async(o:any)=>{containers.push({Id:'proxy',Config:o,HostConfig:o.HostConfig,State:{Running:false},NetworkSettings:{Networks:{[o.HostConfig.NetworkMode]:{NetworkID:o.HostConfig.NetworkMode}}}});return{id:'proxy'}},start:async()=>{containers[0].State.Running=true},inspect:async()=>containers[0],exec:async()=>({exitCode:0}),remove:async()=>{containers.length=0}};
 const network:any={inspect:async(name:string)=>nets.find(n=>n.Name===name)??null,create:async(name:string,internal:boolean,labels:any)=>{const n={Id:name,Name:name,Internal:internal,Labels:labels,EnableIPv6:false,Options:internal?{'com.docker.network.bridge.inhibit_ipv4':'true'}:{}};nets.push(n);return n},connect:async(id:string)=>{containers[0].NetworkSettings.Networks[id]={NetworkID:id}},remove:async()=>{}};
 const manager=new SandboxNetworkManager(engine,network);
 const context=await manager.ensure(owner);
 assert.equal(nets.filter(n=>n.Internal).length,1);assert.equal(containers[0].HostConfig.Sysctls['net.ipv4.ip_forward'],'0');assert.match(context.proxyUrl,/3128/);
 const o=dockerSandboxCreateOptions('/tmp/net-test/users/'+owner.userId+'/workspace',{},context);validateDockerCreateConfig(o,'/tmp/net-test/users/'+owner.userId+'/workspace',context);
 assert.equal(o.HostConfig.NetworkMode,context.networkId);assert.equal(o.HostConfig.PortBindings,undefined);
 const previous=containers[0];previous.NetworkSettings.Networks.unexpected={NetworkID:'unexpected'};await manager.ensure(owner);assert.notEqual(containers[0],previous);
 network.inspect=async()=>{throw new Error('network unavailable')}; await assert.rejects(()=>manager.ensure(owner),/network unavailable/);
 delete process.env.SANDBOX_NETWORK_MODE;
});

test('offline restart sweep reclaims orphan networks even without a remaining proxy',async()=>{
 process.env.SANDBOX_NETWORK_MODE='none';const removed:string[]=[];
 const orphan={Id:'orphan',Name:'nero-egress-'+owner.userId+'-internal',Internal:true,Created:'2020-01-01T00:00:00Z',Labels:{'nero.egress':'1','nero.egress.user':owner.userId}};
 const engine:any={findLabeled:async()=>[],remove:async()=>{}};
 const networks:any={listOwned:async()=>[orphan],inspect:async(name:string)=>name===orphan.Name?orphan:null,remove:async(id:string)=>{removed.push(id)}};
 await new SandboxNetworkManager(engine,networks).sweep(Date.now());assert.deepEqual(removed,['orphan']);
});
