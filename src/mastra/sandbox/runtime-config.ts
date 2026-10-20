import { createHash } from 'node:crypto';
export function getSandboxRuntimeConfig() {
 const networkMode=process.env.SANDBOX_NETWORK_MODE ?? 'none';
 if(networkMode!=='none' && networkMode!=='public-http') throw new Error('Invalid SANDBOX_NETWORK_MODE');
 const proxyImage=process.env.SANDBOX_EGRESS_IMAGE?.trim();
 if(networkMode==='public-http' && (!proxyImage || !/^.+@sha256:[a-f0-9]{64}$/i.test(proxyImage))) throw new Error('SANDBOX_EGRESS_IMAGE must be pinned to an image digest');
 return {bashEnabled:process.env.SANDBOX_BASH_ENABLED==='true',dependenciesEnabled:process.env.SANDBOX_DEPENDENCIES_ENABLED==='true',networkMode,proxyImage,policyVersion:'public-http-v1'} as const;
}
export function runtimeFingerprint(image:string):string {
 return createHash('sha256').update(JSON.stringify({image,...getSandboxRuntimeConfig()})).digest('hex');
}
