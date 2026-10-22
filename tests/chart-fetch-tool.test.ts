import test from 'node:test';import assert from 'node:assert/strict';
import {createTool} from '@mastra/core/tools';import {z} from 'zod';
import {withChartDataFetch} from '../src/mastra/agents/chart-fetch-tool';
const original=(content:string,truncated=false)=>createTool({id:'web_fetch',inputSchema:z.object({url:z.string()}),execute:async({url})=>({url,content,ok:true,truncated})});
test('HTML is rejected at retrieval rather than promoted to chart data',async()=>{
 const tool=withChartDataFetch(original('<html>27日可能22度</html>') as any);
 const result:any=await tool.execute!({url:'https://example.com/forecast'},{} as any);
 assert.equal(result.ok,false);assert.match(result.content,/JSON|Open-Meteo/);assert.doesNotMatch(result.content,/<html>/);
});
test('complete structured JSON preserves the original evidence; truncated JSON cannot pass',async()=>{
 const input={url:'https://example.com/data'};
 const good=withChartDataFetch(original('{"time":["a"],"values":[1]}') as any);
 assert.equal((await good.execute!(input,{} as any) as any).content,'{"time":["a"],"values":[1]}');
 const truncated=withChartDataFetch(original('{"values":[1]}',true) as any);
 assert.equal((await truncated.execute!(input,{} as any) as any).ok,false);
});
