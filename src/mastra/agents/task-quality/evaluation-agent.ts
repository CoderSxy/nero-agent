import { Agent } from '@mastra/core/agent';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { RequestContext } from '@mastra/core/request-context';
import { createTransportModel } from '../../models/transport';
import { createTurnPolicyProcessor } from '../turn-policy-processor';
import { createTaskQualityProcessor } from './processor';
import { MODEL_CAPABILITIES_CONTEXT_KEY } from '../../models/capabilities';
import type { TaskOutcome } from './types';

/** Evaluation uses the real SDK, Agent loop, fetch tool adapter, submission schema,
 * provenance validation, renderer and completion processor. Only the provider and
 * external API response are fixtures. No coverage/met flags are injected. */
export async function runFixtureAgent(item: {id:string;userText:string;answer:string}, now: Date) {
  const dates=Array.from({length:7},(_,i)=>new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),now.getUTCDate()+i)).toISOString().slice(0,10));
  if(item.id==='weather-range-invalid') dates.splice(0,7,...dates.map(d=>d.replace(/^\d{4}/,'2025')));
  const daily: Record<string, unknown>={time:dates,weather_code:[0,1,3,61,3,1,0],temperature_2m_max:[22,23,24,22,21,20,19],temperature_2m_min:[12,13,14,12,11,10,9],precipitation_sum:[0,0,0,5,1,0,0]};
  const units: Record<string,string>={temperature_2m_max:'°C',temperature_2m_min:'°C',precipitation_sum:'mm',relative_humidity_2m:'%'};
  const pairs=[['temperature-max','temperature_2m_max'],['temperature-min','temperature_2m_min'],['precipitation-amount','precipitation_sum']];
  const noCondition=['weather-condition-missing','duplicate-outcome'].includes(item.id);
  const noRain=item.id==='weather-precipitation-missing';
  if(item.id==='weather-code-unknown') daily.weather_code=[123,1,3,61,3,1,0];
  const humidity=item.userText.includes('湿度') && !item.id.includes('hours-missing');
  if(humidity) {daily.relative_humidity_2m=Array(7).fill(60);pairs.push(['humidity-mean','relative_humidity_2m']);}
  const selected=pairs.filter(([metric])=>!(noRain&&metric==='precipitation-amount'));
  const url='https://example.com/forecast';
  const response={latitude:31.23,longitude:121.47,timezone:'Asia/Shanghai',daily,daily_units:units};
  const body={schemaVersion:2,kind:'weather',status:'ready',reason:'',title:'上海天气',dataset:{categories:dates,series:selected.map(([metric,key])=>({metric,name:metric,unit:units[key],values:daily[key]})),sources:[{kind:'url',label:'fixture',url}]},weather:{location:{name:'上海',latitude:31.23,longitude:121.47},timezone:'Asia/Shanghai',dates,weatherCodes:noCondition?Array(7).fill(null):daily.weather_code,fieldSources:[...selected,...(!noCondition?[['weather-code','weather_code']]:[])].map(([metric,key])=>({kind:'url',metric,sourceUrl:url,recordPath:['daily'],dateField:'time',valueField:key,unitField:key,transform:'identity'}))}};
  const rc=new RequestContext();
  rc.set(MODEL_CAPABILITIES_CONTEXT_KEY, {toolCalling:'supported',forcedToolChoice:item.id==='forced-tool-unsupported'?'unsupported':'supported',jsonSchema:item.id==='gateway-ignores-schema'?'unsupported':'supported'});
  const weather=/天气|温度/.test(item.userText)&&item.id!=='budget-stop';
  let calls=0, tools=0;
  const model=createTransportModel({id:'fixture/test',url:'https://example.com/v1',apiKey:'fixture',api:'chat'},{jsonSchema:'supported',fetchImpl:async(_input,init)=>{
    calls++;
    const request=JSON.parse(String(init?.body));
    if(weather&&calls===1) {
      if(!request.tools?.some((t:any)=>t.function.name==='web_fetch'&&t.function.parameters.properties.url)) throw new Error('missing real fetch schema');
    }
    const tool=weather&&(calls===1||calls===2);
    const message=tool?{role:'assistant',tool_calls:[{id:`fixture-${calls}`,type:'function',function:{name:calls===1?'web_fetch':'submit_chart_data',arguments:JSON.stringify(calls===1?{url}:body)}}]}:{role:'assistant',content:item.id==='budget-stop' ? JSON.stringify({schemaVersion:2,kind:'weather',status:'insufficient-data',reason:'fixture 模拟取数预算耗尽，没有可用数据',title:'',dataset:null,weather:null}) : item.answer};
    return Response.json({id:'fixture',object:'chat.completion',created:0,model:'test',choices:[{index:0,message,finish_reason:tool?'tool_calls':'stop'}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}});
  }});
  let outcome: TaskOutcome|undefined;
  const turn=createTurnPolicyProcessor(), quality=createTaskQualityProcessor({now:()=>now,persist:async(_id,value)=>{outcome=value;}});
  const agent=new Agent({id:`eval-${item.id}`,name:'evaluation',instructions:'fixture task',model,tools:{web_fetch:createTool({id:'web_fetch',description:'Read a fixture forecast',inputSchema:z.object({url:z.string()}),execute:async()=>{tools++;return {url,content:JSON.stringify(response),isError:false,truncated:false};}})},inputProcessors:[turn,quality],outputProcessors:[turn,quality],maxProcessorRetries:1,defaultOptions:{maxSteps:6}});
  const result = await agent.generate(item.userText,{requestContext:rc});
  return {outcome,calls,tools:(result.response.messages ?? []).filter(message=>message.role==='tool').length, text:result.text, messages: result.response.messages};
}
