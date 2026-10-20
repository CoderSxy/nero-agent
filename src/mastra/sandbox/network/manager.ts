import type { DockerEngine } from '../docker/client';
import { createDockerodeEngine } from '../docker/client';
import type { SandboxOwner } from '../types';
import { commandQueue } from '../execution-queue';
import { getSandboxRuntimeConfig,runtimeFingerprint } from '../runtime-config';
import { createDockerNetworkEngine,type DockerNetworkEngine } from './docker-engine';
export type SandboxNetworkContext={networkId:string;proxyUrl:string;fingerprint:string};
const LABEL='nero.egress';
export class SandboxNetworkManager{
 private tails=new Map<string,Promise<unknown>>();
 private lastUsed=new Map<string,number>();
 constructor(private engine:DockerEngine,private networks:DockerNetworkEngine){}
 async ensure(owner:SandboxOwner):Promise<SandboxNetworkContext>{
  const previous=this.tails.get(owner.userId)??Promise.resolve();
  const next=previous.catch(()=>{}).then(()=>this.provision(owner));this.tails.set(owner.userId,next);
  try{return await next}finally{if(this.tails.get(owner.userId)===next)this.tails.delete(owner.userId)}
 }
 private async provision(owner:SandboxOwner):Promise<SandboxNetworkContext>{
  if(!/^[a-f0-9-]{36}$/.test(owner.userId))throw new Error('Invalid sandbox network owner');
  const config=getSandboxRuntimeConfig();if(config.networkMode!=='public-http'||!config.proxyImage)throw new Error('Public network unavailable');
  const labels={[LABEL]:'1','nero.egress.user':owner.userId};
  const prefix='nero-egress-'+owner.userId;
  const getNetwork=async(name:string,internal:boolean)=>{
   const n=await this.networks.inspect(name)??await this.networks.create(name,internal,labels);
   if(n.Labels?.[LABEL]!=='1'||n.Labels?.['nero.egress.user']!==owner.userId||n.Internal!==internal||n.EnableIPv6 || (internal&&n.Options?.['com.docker.network.bridge.inhibit_ipv4']!=='true'))throw new Error('Sandbox network policy mismatch');return n;
  };
  const inside=await getNetwork(prefix+'-internal',true);const outside=await getNetwork(prefix+'-outbound',false);
  const fingerprint=runtimeFingerprint(config.proxyImage);
  const proxies=(await this.engine.findLabeled('nero.egress.user',owner.userId)).filter(p=>p.Config?.Labels?.[LABEL]==='1');
  let proxy: typeof proxies[number] | undefined=proxies[0];
  if(proxies.length>1)throw new Error('Ambiguous sandbox egress containers');
  if(proxy && (proxy.Config?.Labels?.['nero.egress.fingerprint']!==fingerprint || proxy.HostConfig?.NetworkMode!==outside.Id || proxy.HostConfig?.Sysctls?.['net.ipv4.ip_forward']!=='0' || proxy.HostConfig?.Privileged || Object.keys(proxy.HostConfig?.PortBindings??{}).length)){
   await this.engine.remove(proxy.Id,true);proxy=undefined;
  }
  if(!proxy){
   const result=await this.engine.create({Image:config.proxyImage,User:'10001:10001',Env:[],Labels:{...labels,'nero.egress.fingerprint':fingerprint},HostConfig:{NetworkMode:outside.Id,ReadonlyRootfs:true,Privileged:false,CapDrop:['ALL'],SecurityOpt:['no-new-privileges:true'],Sysctls:{'net.ipv4.ip_forward':'0'},Memory:128*1024*1024,MemorySwap:128*1024*1024,PidsLimit:64,NanoCpus:250000000}});
   try{await this.networks.connect(inside.Id,result.id,'nero-egress');await this.engine.start(result.id)}catch(e){await this.engine.remove(result.id,true).catch(()=>{});throw e}
   proxy=(await this.engine.inspect(result.id))!;
  }else if(!proxy.State.Running){await this.engine.start(proxy.Id)}
  const health=await this.engine.exec(proxy.Id,'node',['-e',"const s=require('net').connect(3128,'127.0.0.1',()=>{s.end();process.exit(0)});s.on('error',()=>process.exit(1));setTimeout(()=>process.exit(1),1500)"],{cwd:'/',timeoutMs:3000});
  if(health.exitCode!==0)throw new Error('Sandbox egress proxy is unavailable');
  this.lastUsed.set(owner.userId,Date.now());
  return {networkId:inside.Id,proxyUrl:'http://nero-egress:3128',fingerprint};
 }
 async removeIdle(owner:SandboxOwner):Promise<void>{
  if(commandQueue.isUserBusy(owner.userId)||this.tails.has(owner.userId))return;
  if((await this.engine.findLabeled('nero.sandbox.user',owner.userId)).some(c=>c.State.Running))return;
  if((await this.engine.findLabeled('nero.skill-run.user',owner.userId)).length)return;
  for(const p of await this.engine.findLabeled('nero.egress.user',owner.userId))if(p.Config?.Labels?.[LABEL]==='1')await this.engine.remove(p.Id,true);
  for(const suffix of ['-internal','-outbound']){const n=await this.networks.inspect('nero-egress-'+owner.userId+suffix);if(n?.Labels?.[LABEL]==='1'&&n.Labels?.['nero.egress.user']===owner.userId)await this.networks.remove(n.Id)}
  this.lastUsed.delete(owner.userId);
 }
 async sweep(now=Date.now()):Promise<void>{
  for(const p of await this.engine.findLabeled(LABEL,'1')){const userId=p.Config?.Labels?.['nero.egress.user'];if(!userId)continue;
   const last=this.lastUsed.get(userId)??Date.parse(p.Created as string??'');
   if(Number.isFinite(last)&&now-last>=86400000)await this.removeIdle({userId,sandboxId:'sb_'+userId});
  }
 }
}
let shared:Promise<SandboxNetworkManager>|undefined;
export function sandboxNetworkManager():Promise<SandboxNetworkManager>{
 if(!shared){shared=Promise.all([createDockerodeEngine(),createDockerNetworkEngine()]).then(([engine,networks])=>{const manager=new SandboxNetworkManager(engine,networks);const timer=setInterval(()=>void manager.sweep().catch(e=>console.error('Sandbox egress cleanup failed',e)),60000);timer.unref();return manager}).catch(e=>{shared=undefined;throw e})}return shared;
}
