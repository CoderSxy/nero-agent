import test from 'node:test';import assert from 'node:assert/strict';
import {createRunMetricsProcessor,createRunTiming,recordTiming,summarizeTiming} from '../src/mastra/agents/run-metrics';
test('memory intervals never inflate answer duration and failed background work does not change answer completion',()=>{
 const s=createRunTiming('run-a',100);recordTiming(s,{kind:'token'},110);recordTiming(s,{kind:'chart'},125);recordTiming(s,{kind:'answer'},130);recordTiming(s,{kind:'memory',cycleId:'one',operation:'buffering',status:'failed',durationMs:520000},520130);
 const r=summarizeTiming(s,520140);assert.equal(r.firstTokenMs,10);assert.equal(r.firstChartMs,25);assert.equal(r.answerMs,30);assert.equal(r.elapsedMs,520040);assert.equal(r.memory[0].durationMs,520000);assert.equal(r.answerComplete,true);
});
test('model and tool timing are separate, duplicate completion events do not increment counts',()=>{
 const s=createRunTiming('a',0);recordTiming(s,{kind:'model-start',step:0,model:'fixture'},5);recordTiming(s,{kind:'model-end',step:0},25);recordTiming(s,{kind:'tool-start',id:'t',name:'web_fetch'},25);recordTiming(s,{kind:'tool-end',id:'t',failed:true},40);recordTiming(s,{kind:'tool-end',id:'t',failed:true},50);
 const r=summarizeTiming(s,50);assert.equal(r.models[0].durationMs,20);assert.equal(r.tools[0].durationMs,15);assert.equal(r.toolFailures,1);assert.equal(summarizeTiming(createRunTiming('b',0),50).tools.length,0);
});
test('a repair attempt keeps the original model timing instead of overwriting it',()=>{
 const s=createRunTiming('r',0);recordTiming(s,{kind:'model-start',step:0,model:'fixture'},0);recordTiming(s,{kind:'model-end',step:0},10);
 recordTiming(s,{kind:'model-start',step:0,attempt:1,model:'fixture'} as any,10);recordTiming(s,{kind:'model-end',step:0,attempt:1} as any,30);
 assert.deepEqual(summarizeTiming(s,30).models.map(m=>m.durationMs),[10,20]);
});

test('locally completed budget steps are not counted as paid model calls',()=>{
 const p=createRunMetricsProcessor({now:()=>10}),state:any={timing:createRunTiming('r',0)};
 p.processLLMRequest({state,stepNumber:0,retryCount:0,model:{modelId:'fixture'}} as any);
 // A local response bypasses the provider and its response hook.
 assert.equal(summarizeTiming(state.timing,10).models.length,0);
 p.processLLMResponse({state,stepNumber:0,retryCount:0,fromCache:false} as any);
 assert.equal(summarizeTiming(state.timing,10).models.length,1);
});
