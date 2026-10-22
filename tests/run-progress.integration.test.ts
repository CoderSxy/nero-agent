import test from 'node:test';import assert from 'node:assert/strict';
import {Agent} from '@mastra/core/agent';import {createTool} from '@mastra/core/tools';import {createOpenAICompatible} from '@ai-sdk/openai-compatible';import {z} from 'zod';
import {createTurnPolicyProcessor} from '../src/mastra/agents/turn-policy-processor';
function fixture(toolName:string,tool:any,reply:(body:any,n:number)=>any){let n=0;const p=createTurnPolicyProcessor();const model=createOpenAICompatible({name:'test',baseURL:'https://test.example/v1',apiKey:'test',fetch:async(_url,init)=>{const body=JSON.parse(String(init?.body));const message=reply(body,++n);return Response.json({id:'r',object:'chat.completion',created:0,model:'test',choices:[{index:0,message:{role:'assistant',...message},finish_reason:message.tool_calls?'tool_calls':'stop'}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}})}}).chatModel('test');return new Agent({id:'progress',name:'progress',instructions:'test',model,tools:{[toolName]:tool},inputProcessors:[p],outputProcessors:[p],maxProcessorRetries:1,defaultOptions:{maxSteps:100}});}
const call=(name:string,n:number,args={})=>({tool_calls:[{id:'call'+n,type:'function',function:{name,arguments:JSON.stringify(args)}}]});
test('three same-state edit errors remove executable tools and preserve failure history',async()=>{
 let attempts=0;const tool=createTool({id:'edit',inputSchema:z.object({path:z.string(),expectedEtag:z.string(),oldText:z.string()}),execute:async()=>{attempts++;throw new Error('原文出现多次，无法唯一替换')}});
 const agent=fixture('edit',tool,(body,n)=>body.tools?.length?call('edit',n,{path:'a',expectedEtag:'v1',oldText:'duplicate'}):{content:'操作未完成，原文匹配不唯一。'});
 const result=await agent.generate('请编辑文件');assert.equal(attempts,3);assert.match(result.text,/未完成/);assert.equal(result.steps.length,4);
});
test('simple chart stops tool loop while a general task can continue past the same budget',async()=>{
 let chartCalls=0;const tool=createTool({id:'web_fetch',inputSchema:z.object({}),execute:async()=>{chartCalls++;return{value:chartCalls}}});
 const chart='```echarts\n{"series":[{"type":"pie","data":[{"value":1,"name":"a"}]}]}\n```';
 const agent=fixture('web_fetch',tool,(body,n)=>body.tools?.length?call('web_fetch',n):{content:chart});await agent.generate('请给我饼图');assert.equal(chartCalls,7);
 let calls=0;const general=createTool({id:'web_fetch',inputSchema:z.object({}),execute:async()=>{calls++;return calls}});
 const longer=fixture('web_fetch',general,(_body,n)=>n<=10?call('web_fetch',n):{content:'完成'});await longer.generate('依次核对十个网页');assert.equal(calls,10);
});
test('compaction cannot erase a reached failure limit within the same run',()=>{
 const p=createTurnPolicyProcessor(),state={};const tools={edit:{}};
 const failures=['a','b','c'].map(id=>({type:'tool-invocation',toolInvocation:{toolCallId:id,toolName:'edit',state:'output-error',errorText:'ambiguous',args:{path:'x',oldText:'duplicate'}}}));
 p.processInputStep({state,tools,messages:[{id:'u',role:'user',content:'编辑文件'},{role:'assistant',content:{parts:failures}}],stepNumber:3} as any);
 const next=p.processInputStep({state,tools,messages:[{role:'assistant',content:'操作摘要'}],stepNumber:4} as any) as any;
 assert.equal(next.toolChoice,'none');
});

test('provider ignoring tool restrictions cannot exceed eight chart model calls',async()=>{
 let requests=0,executions=0;const tool=createTool({id:'web_fetch',inputSchema:z.object({}),execute:async()=>++executions});
 const agent=fixture('web_fetch',tool,(_body,n)=>{requests++;return call('web_fetch',n)});
 const result=await agent.generate('请给我饼图');
 assert.equal(requests,8);assert.equal(executions,7);assert.match(result.text,/执行预算|未完成/);
});

test('a provider ignoring tool-free correction gets only one repair call',async()=>{
 let requests=0;const tool=createTool({id:'web_fetch',inputSchema:z.object({}),execute:async()=>({value:1})});
 const agent=fixture('web_fetch',tool,(_body,n)=>{requests++;return n===1?{content:'无效图表'}:call('web_fetch',n)});
 const result=await agent.generate('请给我饼图');
 assert.equal(requests,2);assert.match(result.text,/图表未完成/);
});
