import type { DockerInspect } from './client';
/** Compare actual attached networks, not only the container's original NetworkMode. */
export function networkAttachmentsMatch(container: DockerInspect | null | undefined, expected: string[]): boolean {
  const networks=container?.NetworkSettings?.Networks;
  // Legacy fake providers omit inspect networking; real Docker always supplies it.
  if(!networks)return expected.length===1&&expected[0]==='none';
  const actual=Object.entries(networks).map(([name,details])=>name==='none'?'none':(details as {NetworkID?:string}).NetworkID??name).sort();
  return actual.length===expected.length&&actual.every((id,index)=>id===[...expected].sort()[index]);
}
