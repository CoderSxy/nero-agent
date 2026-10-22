import test from 'node:test';
import assert from 'node:assert/strict';
import {Agent} from '@mastra/core/agent';
import {createTool,askUserTool,webFetchTool} from '@mastra/core/tools';
import {createOpenAICompatible} from '@ai-sdk/openai-compatible';
import {z} from 'zod';
import {createRunMetricsProcessor} from '../src/mastra/agents/run-metrics';
import {createTurnPolicyProcessor} from '../src/mastra/agents/turn-policy-processor';
const chart=JSON.stringify({status:'ready',reason:'',title:'测试趋势',dataset:{categories:['a','b'],series:[{name:'值',unit:'',values:[1,2]}],sources:[{kind:'user',label:'用户提供的数据',url:''}]}});
function model(replies:any[],requests:any[]){return createOpenAICompatible({name:'test',baseURL:'https://test.example/v1',apiKey:'test',supportsStructuredOutputs:true,fetch:async(_url,init)=>{
 const body=JSON.parse(String(init?.body));requests.push(body);const reply=replies.shift();const reason=reply.tool_calls?'tool_calls':'stop';
 if(body.stream){
  const delta={role:'assistant',...reply,...reply.tool_calls?{tool_calls:reply.tool_calls.map((t:any,index:number)=>({...t,index}))}:{}};
  const chunks=[{id:'r',object:'chat.completion.chunk',created:0,model:'test',choices:[{index:0,delta,finish_reason:null}]},{id:'r',object:'chat.completion.chunk',created:0,model:'test',choices:[{index:0,delta:{},finish_reason:reason}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}}];
  return new Response(chunks.map(c=>'data: '+JSON.stringify(c)+'\n\n').join('')+'data: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
 }
 return Response.json({id:'r',object:'chat.completion',created:0,model:'test',choices:[{index:0,message:{role:'assistant',...reply},finish_reason:reason}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}});
}}).chatModel('test');}
const call=(name:string,id:string)=>({id,type:'function',function:{name,arguments:JSON.stringify(name==='web_fetch'?{url:'https://example.com/data'}:{})}});
test('inline chart request cannot execute a model-requested file write',async()=>{
 let writes=0;const requests:any[]=[];
 const tool=createTool({id:'write_file',inputSchema:z.object({}),execute:async()=>{writes++;return 'written'}});
 const p=createTurnPolicyProcessor();
 const agent=new Agent({id:'chart',name:'chart',instructions:'test',model:model([{tool_calls:[call('write_file','w')]},{content:chart}],requests),tools:{write_file:tool},inputProcessors:[p],outputProcessors:[p],maxProcessorRetries:1,defaultOptions:{maxSteps:8}});
 const result=await agent.generate('测试数据a=1,b=2，给我趋势图');
 assert.equal(writes,0);assert.match(result.text,/echarts/);assert.equal(requests[0].tools?.some((t:any)=>t.function.name==='write_file')??false,false);
});

const submission={status:'ready',reason:'',title:'测试气温',dataset:{categories:['一月','二月'],series:[{name:'气温',unit:'℃',values:[10,20]}],sources:[{kind:'user',label:'用户提供的测试数据',url:''}]}};
test('native chart schema produces a platform-built chart from a frozen dataset',async()=>{
 const requests:any[]=[];const p=createTurnPolicyProcessor(), metrics=createRunMetricsProcessor();
 const agent=new Agent({id:'structured-chart',name:'structured chart',instructions:'test',model:model([{content:JSON.stringify(submission)}],requests),inputProcessors:[p,metrics],outputProcessors:[p,metrics],maxProcessorRetries:1});
 const stream=await agent.stream('使用测试数据：一月10，二月20，给我气温趋势图');const chunks:any[]=[];for await(const c of stream.fullStream)chunks.push(c);
 assert.equal(requests[0].response_format?.type,'json_schema');
 const ready=chunks.find(c=>c.type==='data-nero-chart'&&c.data.status==='ready');
 assert.ok(ready);assert.deepEqual(ready.data.option.series[0].data,[10,20]);assert.match(ready.data.markdown,/```echarts/);
 assert.equal(requests.length,1);
 assert.ok(chunks.find(c=>c.type==='data-nero-answer-complete').data.firstChartMs>=0);
});
test('explicit insufficient data is not retried or reported as an invalid chart',async()=>{
 const requests:any[]=[];const p=createTurnPolicyProcessor();
 const agent=new Agent({id:'insufficient',name:'insufficient',instructions:'test',model:model([{content:JSON.stringify({status:'insufficient-data',reason:'仅有三天预报',title:'',dataset:null})}],requests),inputProcessors:[p],outputProcessors:[p],maxProcessorRetries:1});
 const stream=await agent.stream('请给我七天天气趋势图');const chunks:any[]=[];for await(const c of stream.fullStream)chunks.push(c);
 assert.equal(requests.length,1);
 assert.ok(chunks.find(c=>c.type==='data-nero-delivery'&&c.data.reason==='insufficient-data'));
});
test('missing chart triggers one tool-free step repair without replaying data retrieval',async()=>{
 let fetches=0;const requests:any[]=[];const p=createTurnPolicyProcessor();
 const fetchTool=createTool({id:'web_fetch',inputSchema:z.object({}),execute:async()=>{fetches++;return {days:['a','b'],values:[1,2]}}});
 const agent=new Agent({id:'repair',name:'repair',instructions:'test',model:model([{tool_calls:[call('web_fetch','f')]},{content:'已经生成HTML文件'},{content:chart}],requests),tools:{web_fetch:fetchTool},inputProcessors:[p],outputProcessors:[p],maxProcessorRetries:1,defaultOptions:{maxSteps:8}});
 const result=await agent.generate('测试数据a=1,b=2，给我趋势图');
 assert.equal(fetches,1);assert.match(result.text,/echarts/);assert.equal(requests.length,3);assert.deepEqual(requests[2].tools.map((t:any)=>t.function.name),['submit_chart_data'],'repair exposes only the pure data handoff');
});
test('failed repair is explicit and finite',async()=>{
 const requests:any[]=[];const p=createTurnPolicyProcessor();
 const agent=new Agent({id:'bad',name:'bad',instructions:'test',model:model([{content:'已完成HTML'},{content:'已完成HTML'}],requests),inputProcessors:[p],outputProcessors:[p],maxProcessorRetries:1});
 const result=await agent.generate('请给折线图');
 assert.equal(requests.length,2);assert.match(result.text,/图表未生成：模型未返回结构化图表数据/);
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
 const stream=await agent.stream('测试数据a=1,b=2，给我趋势图');const chunks:any[]=[];for await(const c of stream.fullStream)chunks.push(c);
 const text=chunks.filter(c=>c.type==='text-delta').map(c=>c.payload.text).join('');
 assert.equal(fetched,1);assert.equal(requests.length,3);assert.match(chunks.find(c=>c.type==='data-nero-chart'&&c.data.status==='ready').data.markdown,/echarts/);
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
 const result=await agent.generate('测试数据a=1,b=2，给我趋势图');assert.match(result.text,/echarts/);assert.equal(requests.length,2);
});

test('format repair reuses observed evidence and cannot cite an unobserved source',async()=>{
 const requests:any[]=[];let fetches=0;const p=createTurnPolicyProcessor();
 const source='https://example.com/forecast';
 const fetchTool=createTool({id:'web_fetch',inputSchema:z.object({url:z.string()}),execute:async()=>{fetches++;return {url:source,categories:['一月','二月'],values:[10,20]}}});
 const data={...submission,dataset:{...submission.dataset,sources:[{kind:'url',label:'已读取的预报',url:source}]}};
 const fetchCall={id:'f',type:'function',function:{name:'web_fetch',arguments:JSON.stringify({url:source})}};
 const agent=new Agent({id:'source-repair',name:'source repair',instructions:'test',model:model([{tool_calls:[fetchCall]},{content:'字符图 999'},{content:JSON.stringify(data)}],requests),tools:{web_fetch:fetchTool},inputProcessors:[p],outputProcessors:[p],maxProcessorRetries:1,defaultOptions:{maxSteps:8}});
 const stream=await agent.stream('请取数给我气温趋势图');const chunks:any[]=[];for await(const c of stream.fullStream)chunks.push(c);
 assert.equal(fetches,1);assert.equal(requests.length,3);assert.deepEqual(requests[2].tools.map((t:any)=>t.function.name),['submit_chart_data']);
 const prompt=JSON.stringify(requests[2].messages);assert.match(prompt,/本轮已取证据/);assert.match(prompt,/example.com/);
 const ready=chunks.find(c=>c.type==='data-nero-chart'&&c.data.status==='ready');assert.ok(ready);assert.deepEqual(ready.data.dataset.series[0].values,[10,20]);
});

test('generate returns the canonical chart on the existing response identity',async()=>{
 const requests:any[]=[];const p=createTurnPolicyProcessor();
 const agent=new Agent({id:'owned-response',name:'owned response',instructions:'test',model:model([{content:chart}],requests),inputProcessors:[p],outputProcessors:[p]});
 const result=await agent.generate('测试数据a=1,b=2，给我趋势图');
 assert.match(result.text,/```echarts/);assert.doesNotMatch(result.text,/"status":"ready"/);
 const response=result.response.messages.filter(m=>m.role==='assistant');assert.equal(response.length,1);
});

test('an ignored JSON response format gets one forced pure data submission, then local rendering',async()=>{
 const requests:any[]=[];const p=createTurnPolicyProcessor();
 const handoff={id:'data',type:'function',function:{name:'submit_chart_data',arguments:chart}};
 const agent=new Agent({id:'forced-data',name:'forced data',instructions:'test',model:model([{content:'ASCII chart'},{tool_calls:[handoff]}],requests),inputProcessors:[p],outputProcessors:[p],maxProcessorRetries:1,defaultOptions:{maxSteps:10}});
 const result=await agent.generate('测试数据a=1,b=2，给我趋势图');
 assert.equal(requests.length,2);assert.equal(requests[1].tool_choice.function.name,'submit_chart_data');
 assert.deepEqual(requests[1].tools.map((t:any)=>t.function.name),['submit_chart_data']);assert.match(result.text,/```echarts/);
});

test('a chart-type followup keeps the prior owned dataset and provenance',async()=>{
 const p=createTurnPolicyProcessor(),state:any={},events:any[]=[];
 const {readChartSubmission,buildChart}=await import('../src/mastra/agents/chart-data');
 const owned=readChartSubmission(chart,{goal:'测试数据a=1,b=2',sourceUrls:[]});assert.ok(owned.ok);
 const built=buildChart(owned.snapshot,'趋势图');
 p.processInputStep({state,tools:{},messages:[{id:'old',role:'assistant',content:{parts:[{type:'text',text:built.markdown},{type:'data-nero-chart',data:{version:2,status:'ready',dataset:owned.snapshot.dataset,datasetHash:owned.snapshot.hash,option:built.option}}]}},{id:'new',role:'user',content:'改成柱状图'}],stepNumber:0} as any);
 await p.processOutputStep({state,text:chart,toolCalls:[],messageList:{},writer:{custom:async(e:any)=>events.push(e)},abort:()=>{throw new Error('unexpected retry')}} as any);
 const ready=events.find(e=>e.type==='data-nero-chart');assert.equal(ready.data.option.series[0].type,'bar');assert.deepEqual(ready.data.dataset.series[0].values,[1,2]);
});

test('native fetch URL schema survives processor adaptation into provider tools',async()=>{
 const requests:any[]=[];const p=createTurnPolicyProcessor();
 const agent=new Agent({id:'native-fetch-schema',name:'native fetch schema',instructions:'test',model:model([{content:JSON.stringify({status:'insufficient-data',reason:'test',title:'',dataset:null})}],requests),tools:{web_fetch:webFetchTool,ask_user:askUserTool},inputProcessors:[p],outputProcessors:[p]});
 await agent.generate('给我天气趋势图');
 const schema=requests[0].tools.find((t:any)=>t.function.name==='web_fetch').function.parameters;
 assert.equal(schema.properties.url?.type,'string');assert.ok(schema.required.includes('url'));
 const question=requests[0].tools.find((t:any)=>t.function.name==='ask_user').function.parameters;assert.equal(question.properties.question?.type,'string');
});
