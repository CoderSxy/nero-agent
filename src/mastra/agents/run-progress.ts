import {createHash} from 'node:crypto';
import {isTurnUserMessage} from './turn-messages';
type Outcome={toolCallId:string;toolName:string;target:string;version?:string;argsFingerprint:string;errorCode?:string;success:boolean};
export function createProgressState(){return {seen:new Set<string>(),targets:new Map<string,{key:string;count:number}>()};}
export function recordToolOutcome(state:ReturnType<typeof createProgressState>,outcome:Outcome){
 if(state.seen.has(outcome.toolCallId))return;
 state.seen.add(outcome.toolCallId);
 const target=outcome.toolName+':'+outcome.target;
 if(outcome.success){state.targets.delete(target);return;}
 const key=[outcome.version??'',outcome.argsFingerprint,outcome.errorCode??'ERROR'].join(':');
 const previous=state.targets.get(target);state.targets.set(target,{key,count:previous?.key===key?previous.count+1:1});
}
export function decideNextStep(state:ReturnType<typeof createProgressState>,simpleChart:boolean,stepNumber:number):'continue'|'recover'|'finalize'{
 const count=Math.max(0,...[...state.targets.values()].map(v=>v.count));
 return count>=3||(simpleChart&&stepNumber>=7)?'finalize':count>=2?'recover':'continue';
}
/** Rebuild from durable invocations: works after resume and never trusts client counters. */
export function progressFromMessages(messages:readonly any[]){
 const state=createProgressState();let start=0;for(let i=0;i<messages.length;i++)if(isTurnUserMessage(messages[i]))start=i+1;
 for(const m of messages.slice(start))for(const p of m.content?.parts??[]){
  const t=p.type==='tool-invocation'?p.toolInvocation:undefined;
  if(!t||!['result','output-error'].includes(t.state))continue;
  const args=t.args??{};
  const error=t.state==='output-error'?t.errorText: t.result?.ok===false?(t.result.errorCode??t.result.error??'ERROR'):undefined;
  // Match editing identity, not replacement content: changing newText alone does
  // not resolve an ambiguous oldText at the same file version.
  const identity=typeof args.oldText==='string'?args.oldText:JSON.stringify(args);
  recordToolOutcome(state,{toolCallId:t.toolCallId,toolName:t.toolName,target:`${args.scope??'thread'}:${args.path??args.url??t.toolName}`,version:args.expectedEtag,argsFingerprint:createHash('sha256').update(identity).digest('hex'),errorCode:error,success:!error});
 }
 return state;
}
