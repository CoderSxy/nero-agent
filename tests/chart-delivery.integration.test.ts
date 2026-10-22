import test from 'node:test';
import assert from 'node:assert/strict';
import {Agent} from '@mastra/core/agent';
import {createTool,askUserTool} from '@mastra/core/tools';
import {createOpenAICompatible} from '@ai-sdk/openai-compatible';
import {z} from 'zod';
import {createRunMetricsProcessor} from '../src/mastra/agents/run-metrics';
import {createTurnPolicyProcessor} from '../src/mastra/agents/turn-policy-processor';
const chart='```echarts\n{"xAxis":{"data":["a","b"]},"yAxis":{},"series":[{"type":"line","data":[1,2]}]}\n```';
function model(replies:any[],requests:any[]){return createOpenAICompatible({name:'test',baseURL:'https://test.example/v1',apiKey:'test',fetch:async(_url,init)=>{
 const body=JSON.parse(String(init?.body));requests.push(body);const reply=replies.shift();const reason=reply.tool_calls?'tool_calls':'stop';
 if(body.stream){
  const delta={role:'assistant',...reply,...reply.tool_calls?{tool_calls:reply.tool_calls.map((t:any,index:number)=>({...t,index}))}:{}};
  const chunks=[{id:'r',object:'chat.completion.chunk',created:0,model:'test',choices:[{index:0,delta,finish_reason:null}]},{id:'r',object:'chat.completion.chunk',created:0,model:'test',choices:[{index:0,delta:{},finish_reason:reason}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}}];
  return new Response(chunks.map(c=>'data: '+JSON.stringify(c)+'\n\n').join('')+'data: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
 }
 return Response.json({id:'r',object:'chat.completion',created:0,model:'test',choices:[{index:0,message:{role:'assistant',...reply},finish_reason:reason}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}});
}}).chatModel('test');}
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
test('a new canonical user signal changes delivery intent within the same run',async()=>{
 const p=createTurnPolicyProcessor();const state={};const tools={web_fetch:{},write_file:{}};
 const invoke=(text:string,id:string)=>p.processInputStep({state,tools,messages:[{id,role:'signal',type:'notification',content:{parts:[{type:'text',text}],metadata:{signal:{type:'user'}}}}],stepNumber:0} as any) as any;
 const first=invoke('给我天气趋势图','one');assert.equal(first.tools.write_file,undefined);
 const next=invoke('现在改成HTML看板','two');assert.equal(next.tools,undefined,'general artifact mode must preserve original tools');
});

test('stream repair appends a corrected chart and completion marker without repeating retrieval',async()=>{
 let fetched=0;const requests:any[]=[];const p=createTurnPolicyProcessor(),metrics=createRunMetricsProcessor();
 const tool=createTool({id:'web_fetch',inputSchema:z.object({}),execute:async()=>{fetched++;return {values:[1,2]}}});
 const agent=new Agent({id:'stream-repair',name:'stream repair',instructions:'test',model:model([{tool_calls:[call('web_fetch','f')]},{content:'HTML完成'},{content:chart}],requests),tools:{web_fetch:tool},inputProcessors:[p,metrics],outputProcessors:[p,metrics],maxProcessorRetries:1,defaultOptions:{maxSteps:10}});
 const stream=await agent.stream('给我趋势图');const chunks:any[]=[];for await(const c of stream.fullStream)chunks.push(c);
 const text=chunks.filter(c=>c.type==='text-delta').map(c=>c.payload.text).join('');
 assert.equal(fetched,1);assert.equal(requests.length,3);assert.match(text,/echarts/);
 assert.equal(chunks.filter(c=>c.type==='data-nero-answer-complete').length,1);
 assert.ok(chunks.find(c=>c.type==='data-nero-delivery'&&c.data.status==='complete'));
});
test('memory compaction dropping the original user message cannot reset the run delivery policy',()=>{
 const p=createTurnPolicyProcessor(),state={};const tools={write_file:{},web_fetch:{}};
 p.processInputStep({state,tools,messages:[{id:'u',role:'user',content:'给我趋势图'}],stepNumber:0} as any);
 const next=p.processInputStep({state,tools,messages:[{id:'summary',role:'assistant',content:'天气数据已取得'}],stepNumber:1} as any) as any;
 assert.equal(next.tools.write_file,undefined);assert.ok(next.tools.web_fetch);
});

test('format-only ask_user is resolved by existing chart policy without suspending the run',async()=>{
 const requests:any[]=[];const p=createTurnPolicyProcessor();
 const ask={id:'format',type:'function',function:{name:'ask_user',arguments:JSON.stringify({question:'你要哪种图表输出格式？',options:[{label:'HTML文件'},{label:'ECharts JSON'}]})}};
 const agent=new Agent({id:'format-choice',name:'format choice',instructions:'test',model:model([{tool_calls:[ask]},{content:chart}],requests),tools:{ask_user:askUserTool},inputProcessors:[p],outputProcessors:[p],maxProcessorRetries:1,defaultOptions:{maxSteps:8}});
 const result=await agent.generate('给我七天天气趋势图');assert.match(result.text,/echarts/);assert.equal(requests.length,2);
});
