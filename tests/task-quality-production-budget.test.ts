import assert from 'node:assert/strict';
import test from 'node:test';
import { Agent } from '@mastra/core/agent';
import { createTool } from '@mastra/core/tools';
import { RequestContext } from '@mastra/core/request-context';
import { z } from 'zod';
import { createTransportModel } from '../src/mastra/models/transport';
import { createTaskQualityProcessor } from '../src/mastra/agents/task-quality/processor';
import { getTaskRuntime, budgetModelFetch } from '../src/mastra/agents/task-quality/runtime';
import { bindSkillServerExecutionId, bindSkillThreadId } from '../src/mastra/skills/execution-context';
import { createMemoryBudget } from '../src/mastra/agents/task-quality/budget';

test('production model transport and processor tools share the bound server budget without ALS',async()=>{
 const rc=new RequestContext();rc.set('mastra__user',{id:'11111111-1111-4111-8111-111111111111',roles:['user']});
 const runId=bindSkillServerExecutionId(rc);bindSkillThreadId(rc,'test-thread');
 const budget=createMemoryBudget();let attempts=0,executions=0,reservations=0;
 const runtime=getTaskRuntime(rc,{reserve:async(auth,input)=>{
   reservations++;
   // Inject storage only: use the real reservation semantics and pre-exhaust
   // 19 general requests so this Agent gets exactly one outbound request.
   return budget.reserve(auth,input);
 },finish:async(id,op,result)=>budget.finalize(id,op,result)})!;
 runtime.enforce=true;
 for(let i=0;i<19;i++)await budget.reserve({userId:'11111111-1111-4111-8111-111111111111',threadId:'test-thread'},{runId,operationId:`prior-${i}`,kind:'main-model',profile:'general',mode:'enforce'});
 const quality=createTaskQualityProcessor();
 const model=createTransportModel({id:'test/test',url:'https://example.com/v1',apiKey:'test',api:'chat'},{wrapFetch:network=>budgetModelFetch(runtime,network),fetchImpl:async()=>{
   attempts++;
   return Response.json({id:'r',object:'chat.completion',created:0,model:'test',choices:[{index:0,message:{role:'assistant',tool_calls:[{id:'tool-1',type:'function',function:{name:'echo',arguments:'{"value":"ok"}'}}]},finish_reason:'tool_calls'}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}});
 }});
 const agent=new Agent({id:'production-budget',name:'test',instructions:'test',model,tools:{echo:createTool({id:'echo',description:'echo',inputSchema:z.object({value:z.string()}),execute:async()=>{executions++;return 'ok';}})},inputProcessors:[quality],outputProcessors:[quality],defaultOptions:{maxSteps:3}});
 const result=await agent.generate('调用 echo 然后回答',{requestContext:rc,runId,modelSettings:{maxRetries:0}});
 assert.match(result.text,/执行预算/);
 assert.equal(attempts,1,'the second real HTTP attempt must not reach the network');
 assert.equal(executions,1,'tool executes through the same guarded runtime');
 assert.equal(reservations,2,'model and tool reserve; the exhausted next step finishes locally');
});
