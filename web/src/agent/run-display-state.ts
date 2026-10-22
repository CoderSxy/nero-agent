import type {MastraDBMessage} from '@mastra/core/agent/message-list';
import {isUserMessage} from './pending-user-message';
export function runDisplayState(messages:MastraDBMessage[],isRunning:boolean){
 let start=0;messages.forEach((m,i)=>{if(isUserMessage(m))start=i+1;});
 const currentParts=messages.slice(start).flatMap(m=>typeof m.content==='string'?[]:m.content.parts??[]) as any[];
 const settled=new Set(currentParts.filter(p=>/^data-om-(buffering|observation)-(end|failed)$/.test(p.type)).map(p=>p.data?.cycleId));
 let answerComplete=false,chartFailed=false;const pending=new Set<string>();
 for(const m of messages.slice(start))for(const part of typeof m.content==='string'?[]:m.content.parts??[]){
  const p=part as any;
  if(p.type==='data-nero-answer-complete')answerComplete=true;
  if(p.type==='data-nero-delivery')chartFailed=p.data?.status==='failed';
  if(/^data-om-(buffering|observation)-start$/.test(p.type)&&p.data?.cycleId&&!settled.has(p.data.cycleId))pending.add(p.data.cycleId);
  if(/^data-om-(buffering|observation)-(end|failed)$/.test(p.type)&&p.data?.cycleId)pending.delete(p.data.cycleId);
 }
 return {answerComplete:answerComplete||!isRunning,chartFailed,memoryPending:pending.size>0};
}
