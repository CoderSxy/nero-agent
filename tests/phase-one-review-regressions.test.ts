import assert from 'node:assert/strict';
import test from 'node:test';
import { readChartSubmission } from '../src/mastra/agents/chart-data';
import { submitChartDataTool } from '../src/mastra/agents/chart-data-tool';
import { createTaskQualityProcessor } from '../src/mastra/agents/task-quality/processor';
import { RequestContext } from '@mastra/core/request-context';

export function weatherSample() {
  const dates = Array.from({length:7},(_,i)=>`2026-10-${22+i}`);
  const response = {latitude:31.3,longitude:120.6,timezone:'Asia/Shanghai',daily:{time:dates,weather_code:[0,1,3,61,3,1,0],temperature_2m_max:[22,23,24,22,21,20,19],temperature_2m_min:[12,13,14,12,11,10,9],precipitation_sum:[0,0,0,5,1,0,0]},daily_units:{temperature_2m_max:'°C',temperature_2m_min:'°C',precipitation_sum:'mm'}};
  const url='https://example.com/forecast';
  const mappings=[['temperature-max','temperature_2m_max'],['temperature-min','temperature_2m_min'],['precipitation-amount','precipitation_sum'],['weather-code','weather_code']];
  const body:any={schemaVersion:2,kind:'weather',status:'ready',reason:'',title:'苏州天气',dataset:{categories:dates,series:mappings.slice(0,3).map(([metric,key])=>({metric,name:metric,unit:(response.daily_units as any)[key],values:(response.daily as any)[key]})),sources:[{kind:'url',label:'预报',url}]},weather:{location:{name:'苏州',latitude:31.3,longitude:120.6},timezone:'Asia/Shanghai',dates,weatherCodes:response.daily.weather_code,fieldSources:mappings.map(([metric,key])=>({kind:'url',metric,sourceUrl:url,recordPath:['daily'],dateField:'time',valueField:key,unitField:key,transform:'identity'}))}};
  return {body,response,url};
}

test('actual submission tool accepts typed weather V2',()=>{
  assert.equal((submitChartDataTool.inputSchema as any).safeParse(weatherSample().body).success,true);
});

test('weather validation rejects unbound fields and detects missing required coverage',()=>{
  const {body,response,url}=weatherSample();
  const read=(value:any)=>readChartSubmission(JSON.stringify(value),{goal:'给我苏州未来七天天气趋势图',sourceUrls:[url],evidence:[{url,value:response}]});
  assert.equal(read(body).ok,true);
  const forged=structuredClone(body);forged.weather.fieldSources=forged.weather.fieldSources.slice(0,1);forged.dataset.series[1].values=[1,2,3,4,5,6,7];
  assert.equal(read(forged).ok,false);
  const missing=structuredClone(body);missing.dataset.series=missing.dataset.series.filter((s:any)=>s.metric!=='precipitation-amount');missing.weather.fieldSources=missing.weather.fieldSources.filter((s:any)=>s.metric!=='precipitation-amount');
  const partial=read(missing);assert.equal(partial.ok,true);if(partial.ok)assert.ok(partial.coverage?.missing.includes('weather.precipitation'));
});

test('contract clock uses the supplied server clock and context timezone',()=>{
  const p=createTaskQualityProcessor({now:()=>new Date('2027-01-01T01:00:00Z')});const state:any={};const rc=new RequestContext();rc.set('neroAgentTimezone','America/Los_Angeles');
  p.processInputStep({messages:[{role:'user',id:'new',content:'未来七天天气趋势图'}],state,requestContext:rc,runId:'new'} as never);
  assert.match(state.taskContract.requirements.find((r:any)=>r.id==='weather.range').description,/2026-12-31\/2027-01-06/);
});

test('an old write_file success cannot verify a new failed export',async()=>{
  const p=createTaskQualityProcessor();const state:any={};const messages:any[]=[{role:'assistant',content:{parts:[{type:'tool-invocation',toolInvocation:{toolName:'write_file',toolCallId:'old',state:'result',result:{path:'/user-files/old/old.csv'}}}]}},{role:'user',id:'new',content:'导出销售 csv'}];
  p.processInputStep({messages,state,requestContext:{get:()=>undefined},runId:'new'} as never);
  let outcome:any;await p.processOutputStep({state,messages,text:'文件没有写成功',toolCalls:[],writer:{custom:async(part:any)=>{outcome=part.data;}}} as never);
  assert.notEqual(outcome.status,'complete');
});

test('file proof is bound to this run and rejects deletion or a changed version',async()=>{
 const {recordWrittenFile,verifyWrittenFiles}=await import('../src/mastra/agents/task-quality/file-evidence');
 const {bindSkillServerExecutionId}=await import('../src/mastra/skills/execution-context');
 const rc=new RequestContext();bindSkillServerExecutionId(rc,'run-a');let etag='v1';
 recordWrittenFile(rc,'report.csv',etag,async()=>({etag}));
 assert.equal((await verifyWrittenFiles(rc))[0].ok,true);
 etag='v2';assert.equal((await verifyWrittenFiles(rc))[0].ok,false);
 bindSkillServerExecutionId(rc,'run-b');assert.deepEqual(await verifyWrittenFiles(rc),[]);
});

test('seven-day weather does not verify a two-day or wrong-year dataset',()=>{
 const {body,response,url}=weatherSample();
 const wrong=structuredClone(body);const source=structuredClone(response);
 wrong.dataset.categories=wrong.dataset.categories.map((d:string)=>d.replace('2026','2025'));
 wrong.weather.dates=wrong.dataset.categories;source.daily.time=wrong.weather.dates;
 const result=readChartSubmission(JSON.stringify(wrong),{goal:'给我苏州未来七天天气趋势图',expectedRange:'2026-10-22/2026-10-28 inclusive',sourceUrls:[url],evidence:[{url,value:source}]});
 assert.equal(result.ok,true);if(result.ok)assert.ok(result.coverage?.missing.includes('weather.range'));
});

test('humidity rejects repeated hours instead of accepting a fake complete day',async()=>{
 const {dailyHumidityMean}=await import('../src/mastra/agents/weather/aggregate');
 assert.equal(dailyHumidityMean({date:'2026-10-22',timeZone:'Asia/Shanghai',times:Array(24).fill('2026-10-22T00:00'),values:Array(24).fill(60)}),null);
});
