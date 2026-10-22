import type {Processor} from '@mastra/core/processors';
import {readBoundServerExecutionId} from '../skills/execution-context';
import {validateInlineChart} from './turn-policy';
type Timed={started:number;durationMs?:number};
type MemoryTiming={cycleId:string;operation:string;status:string;durationMs:number};
export function createRunTiming(runId:string,now:number){return {runId,started:now,firstToken:undefined as number|undefined,firstChart:undefined as number|undefined,answer:undefined as number|undefined,models:new Map<string,Timed&{model:string;step:number;attempt:number}>(),tools:new Map<string,Timed&{name:string;failed?:boolean}>(),memory:new Map<string,MemoryTiming>()};}
type Timing=ReturnType<typeof createRunTiming>;
type Event={kind:'token'|'chart'|'answer'}|{kind:'model-start';step:number;model:string;attempt?:number}|{kind:'model-end';step:number;attempt?:number}|{kind:'tool-start';id:string;name:string}|{kind:'tool-end';id:string;failed:boolean}|({kind:'memory'}&MemoryTiming);
export function recordTiming(s:Timing,event:Event,now:number){
 switch(event.kind){
  case 'token':s.firstToken??=now;break;
  case 'chart':s.firstChart??=now;break;
  case 'answer':s.answer??=now;break;
  case 'model-start':s.models.set(`${event.step}:${event.attempt??0}`,{model:event.model,step:event.step,attempt:event.attempt??0,started:now});break;
  case 'model-end':{const m=s.models.get(`${event.step}:${event.attempt??0}`);if(m&&m.durationMs===undefined)m.durationMs=now-m.started;break;}
  case 'tool-start':if(!s.tools.has(event.id))s.tools.set(event.id,{name:event.name,started:now});break;
  case 'tool-end':{const t=s.tools.get(event.id);if(t&&t.durationMs===undefined){t.durationMs=now-t.started;t.failed=event.failed;}break;}
  case 'memory':s.memory.set(event.cycleId,{cycleId:event.cycleId,operation:event.operation,status:event.status,durationMs:event.durationMs});break;
 }
}
export function summarizeTiming(s:Timing,now:number){return {runId:s.runId,elapsedMs:now-s.started,firstTokenMs:s.firstToken===undefined?undefined:s.firstToken-s.started,firstChartMs:s.firstChart===undefined?undefined:s.firstChart-s.started,answerMs:s.answer===undefined?undefined:s.answer-s.started,answerComplete:s.answer!==undefined,models:[...s.models.values()].map(m=>({step:m.step,attempt:m.attempt,model:m.model,durationMs:m.durationMs})),tools:[...s.tools.entries()].map(([id,t])=>({id,name:t.name,durationMs:t.durationMs,failed:t.failed})),toolFailures:[...s.tools.values()].filter(t=>t.failed).length,memory:[...s.memory.values()]};}
export function createRunMetricsProcessor({now=()=>performance.now()}={}){
 return {
  id:'run-metrics',
  processInputStep({state,runId,requestContext}){state.timing??=createRunTiming(runId??readBoundServerExecutionId(requestContext)??'local',now());},
  processLLMRequest({state,stepNumber,model,retryCount}){
   const s=state.timing as Timing|undefined;if(!s)return;
   const m=model as {modelId?:string;provider?:string};
   // No endpoint, prompt or credentials in metric payloads.
   state.pendingModel={step:stepNumber,attempt:retryCount,model:`${m.provider??'model'}/${m.modelId??'selected'}`.slice(0,160),started:now()};
  },
  processLLMResponse({state,stepNumber,retryCount,fromCache}){
   const s=state.timing as Timing|undefined;
   const pending=state.pendingModel as {step:number;attempt:number;model:string;started:number}|undefined;
   if(s&&pending&&!fromCache){
    recordTiming(s,{kind:'model-start',step:pending.step,attempt:pending.attempt,model:pending.model},pending.started);
    recordTiming(s,{kind:'model-end',step:stepNumber,attempt:retryCount},now());
   }
   delete state.pendingModel;
  },
  async processOutputStream({part,state,tracingContext}){
   const s=state.timing as Timing|undefined;if(!s)return part;
   const chunk=part as any;const p=chunk.payload??{};
   if(part.type==='text-delta')recordTiming(s,{kind:'token'},now());
   if(part.type==='tool-call')recordTiming(s,{kind:'tool-start',id:p.toolCallId,name:p.toolName},now());
   if(part.type==='tool-result'||part.type==='tool-error')recordTiming(s,{kind:'tool-end',id:p.toolCallId,failed:part.type==='tool-error'||p.result?.ok===false},now());
   if(part.type.startsWith('data-om-')&&chunk.data?.cycleId&&Number.isFinite(chunk.data.durationMs)){
    recordTiming(s,{kind:'memory',cycleId:chunk.data.cycleId,operation:chunk.data.operationType??'observation',status:part.type.includes('failed')?'failed':'complete',durationMs:chunk.data.durationMs},now());
    tracingContext?.currentSpan?.update({metadata:{runTiming:summarizeTiming(s,now())}});
   }
   return part;
  },
  async processOutputStep({state,text,toolCalls,messageList,writer,tracingContext}){
   const s=state.timing as Timing|undefined;
   if(s&&!toolCalls?.length){
    if(validateInlineChart(text??'').ok)recordTiming(s,{kind:'chart'},now());
    recordTiming(s,{kind:'answer'},now());
    const summary=summarizeTiming(s,now());
    tracingContext?.currentSpan?.update({metadata:{runTiming:summary}});
    await writer?.custom({type:'data-nero-answer-complete',data:summary});
   }
   return messageList;
  },
 } satisfies Processor;
}
