import test from 'node:test';import assert from 'node:assert/strict';
import {askUserTool} from '@mastra/core/tools';
import {withChartDeliveryQuestionPolicy} from '../src/mastra/agents/chart-question-tool';
test('resolved chart delivery questions do not suspend or impersonate a new user answer',async()=>{
 let suspended=0;const tool=withChartDeliveryQuestionPolicy(askUserTool);
 const result=await tool.execute!({question:'图表形态确认一下，你要哪种产出？',options:[{label:'HTML 单文件'},{label:'ECharts / Chart.js 版'}]},{agent:{suspend:async()=>{suspended++;}}} as any) as any;
 assert.equal(suspended,0);assert.match(result.content,/平台.*ECharts/);assert.doesNotMatch(result.content,/User answered/);
});
test('actual data or location questions still suspend normally',async()=>{
 let suspended=0;const tool=withChartDeliveryQuestionPolicy(askUserTool);
 await tool.execute!({question:'请问你需要哪个城市的天气？',options:[{label:'苏州'},{label:'上海'}]},{agent:{suspend:async()=>{suspended++;}}} as any);
 assert.equal(suspended,1);
});
