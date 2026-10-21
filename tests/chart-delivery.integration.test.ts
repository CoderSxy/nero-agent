import test from 'node:test';
import assert from 'node:assert/strict';
import {Agent} from '@mastra/core/agent';
import {createTool} from '@mastra/core/tools';
import {createOpenAICompatible} from '@ai-sdk/openai-compatible';
import {z} from 'zod';
import {createTurnPolicyProcessor} from '../src/mastra/agents/turn-policy-processor';
const chart='```echarts\n{"xAxis":{"data":["a","b"]},"yAxis":{},"series":[{"type":"line","data":[1,2]}]}\n```';
function model(replies:any[],requests:any[]){return createOpenAICompatible({name:'test',baseURL:'https://test.example/v1',apiKey:'test',fetch:async(_url,init)=>{requests.push(JSON.parse(String(init?.body)));return Response.json({id:'r',object:'chat.completion',created:0,model:'test',choices:[{index:0,message:{role:'assistant',...replies.shift()},finish_reason:replies.length?'tool_calls':'stop'}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}})}}).chatModel('test');}
const call=(name:string,id:string)=>({id,type:'function',function:{name,arguments:'{}'}});
test('inline chart request cannot execute a model-requested file write',async()=>{
 let writes=0;const requests:any[]=[];
 const tool=createTool({id:'write_file',inputSchema:z.object({}),execute:async()=>{writes++;return 'written'}});
 const p=createTurnPolicyProcessor();
 const agent=new Agent({id:'chart',name:'chart',instructions:'test',model:model([{tool_calls:[call('write_file','w')]},{content:chart}],requests),tools:{write_file:tool},inputProcessors:[p],outputProcessors:[p],maxProcessorRetries:1,defaultOptions:{maxSteps:8}});
 const result=await agent.generate('给我一个天气趋势图');
 assert.equal(writes,0);assert.match(result.text,/echarts/);assert.equal(requests[0].tools?.some((t:any)=>t.function.name==='write_file')??false,false);
});
test('missing chart triggers one tool-free step repair without replaying data retrieval',async()=>{
 let fetches=0;const requests:any[]=[];const p=createTurnPolicyProcessor();
 const fetchTool=createTool({id:'web_fetch',inputSchema:z.object({}),execute:async()=>{fetches++;return {days:['a','b'],values:[1,2]}}});
 const agent=new Agent({id:'repair',name:'repair',instructions:'test',model:model([{tool_calls:[call('web_fetch','f')]},{content:'已经生成HTML文件'},{content:chart}],requests),tools:{web_fetch:fetchTool},inputProcessors:[p],outputProcessors:[p],maxProcessorRetries:1,defaultOptions:{maxSteps:8}});
 const result=await agent.generate('给我天气趋势图');
 assert.equal(fetches,1);assert.match(result.text,/echarts/);assert.equal(requests.length,3);assert.equal(requests[2].tools?.length??0,0,'repair must expose no tools');
});
test('failed repair is explicit and finite',async()=>{
 const requests:any[]=[];const p=createTurnPolicyProcessor();
 const agent=new Agent({id:'bad',name:'bad',instructions:'test',model:model([{content:'已完成HTML'},{content:'已完成HTML'}],requests),inputProcessors:[p],outputProcessors:[p],maxProcessorRetries:1});
 const result=await agent.generate('请给折线图');
 assert.equal(requests.length,2);assert.match(result.text,/图表未能生成/);
});
