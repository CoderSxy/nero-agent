import {it,expect} from 'vitest';
import {runDisplayState} from './run-display-state';
const m=(parts:any[],role='assistant')=>({role,content:{parts}} as any);
it('shows background memory separately from completed answer and retains chart failure',()=>{
 const messages=[m([{type:'data-nero-answer-complete',data:{runId:'r'}},{type:'data-nero-delivery',data:{status:'failed'}},{type:'data-om-buffering-start',data:{cycleId:'c'}}])];
 expect(runDisplayState(messages,true)).toMatchObject({answerComplete:true,memoryPending:true,chartFailed:true});
 messages.push(m([{type:'data-om-buffering-end',data:{cycleId:'c'}}]));expect(runDisplayState(messages,true).memoryPending).toBe(false);
});
it('never lets an old completion marker settle a new user turn',()=>{
 const messages=[m([{type:'data-nero-answer-complete',data:{runId:'old'}}]),m([{type:'text',text:'new question'}],'user')];
 expect(runDisplayState(messages,true).answerComplete).toBe(false);
});
it('a late replayed start cannot reopen a completed memory cycle',()=>{
 expect(runDisplayState([m([{type:'data-om-buffering-end',data:{cycleId:'c'}},{type:'data-om-buffering-start',data:{cycleId:'c'}}])],true).memoryPending).toBe(false);
});
