import type Docker from 'dockerode';
export type NetworkInfo={Id:string;Name:string;Internal:boolean;EnableIPv6?:boolean;Labels?:Record<string,string>;Options?:Record<string,string>;Containers?:Record<string,unknown>};
export interface DockerNetworkEngine{
 inspect(name:string):Promise<NetworkInfo|null>;
 create(name:string,internal:boolean,labels:Record<string,string>):Promise<NetworkInfo>;
 connect(networkId:string,containerId:string,alias:string):Promise<void>;
 remove(networkId:string):Promise<void>;
}
export async function createDockerNetworkEngine(instance?:Docker):Promise<DockerNetworkEngine>{
 const {default:Constructor}=await import('dockerode');const docker=instance??new Constructor();
 return {
  async inspect(name){try{return await docker.getNetwork(name).inspect() as NetworkInfo}catch(e){if((e as {statusCode?:number}).statusCode===404)return null;throw e}},
  async create(name,internal,labels){const n=await docker.createNetwork({Name:name,Driver:'bridge',Internal:internal,EnableIPv6:false,Labels:labels,Options:internal?{'com.docker.network.bridge.inhibit_ipv4':'true'}:{}});return await n.inspect() as NetworkInfo},
  async connect(id,containerId,alias){await docker.getNetwork(id).connect({Container:containerId,EndpointConfig:{Aliases:[alias]}})},
  async remove(id){await docker.getNetwork(id).remove()},
 };
}
