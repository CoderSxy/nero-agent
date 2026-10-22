import test from 'node:test';
import assert from 'node:assert/strict';
import {buildChart,readChartSubmission} from '../src/mastra/agents/chart-data';
import {validateInlineChart} from '../src/mastra/agents/turn-policy';
const data={categories:['一月','二月'],series:[{name:'气温',unit:'℃',values:[10,20]}],sources:[{kind:'user',label:'输入数据',url:''}]};
const submit=(dataset:any=data)=>JSON.stringify({status:'ready',reason:'',title:'气温',dataset});
const context={goal:'一月10，二月20，请给趋势图',sourceUrls:[]};
test('owns a deeply immutable dataset; line/bar/pie cannot change its values or hash',()=>{
 const result=readChartSubmission(submit(),context);assert.ok(result.ok);
 const snapshot=result.snapshot,hash=snapshot.hash;
 assert.throws(()=>{snapshot.dataset.series[0].values[0]=999;},TypeError);
 for(const goal of ['趋势图','柱状图','饼图'])assert.ok(validateInlineChart(buildChart(snapshot,goal).markdown).ok);
 assert.equal(snapshot.hash,hash);assert.deepEqual(snapshot.dataset.series[0].values,[10,20]);
});
test('refuses unobserved sources, missing weather days and changed user data',()=>{
 const online={...data,sources:[{kind:'url',label:'天气',url:'https://example.com/forecast'}]};
 assert.deepEqual(readChartSubmission(submit(online),context),{ok:false,reason:'unverified-source'});
 assert.ok(readChartSubmission(submit(online),{...context,sourceUrls:['https://example.com/forecast'],evidence:[{url:'https://example.com/forecast',value:data}]}).ok);
 assert.deepEqual(readChartSubmission(submit(),{...context,goal:'请给我七天天气趋势图'}),{ok:false,reason:'insufficient-data'});
 assert.deepEqual(readChartSubmission(submit({...data,series:[{...data.series[0],values:[10,999]}]}),context),{ok:false,reason:'unverified-source'});
});
test('data shape and JSON errors are distinct from absent submissions',()=>{
 assert.equal((readChartSubmission('ASCII 图',context) as any).reason,'missing-chart');
 assert.equal((readChartSubmission('{oops',context) as any).reason,'invalid-json');
 assert.equal((readChartSubmission(submit({...data,series:[{...data.series[0],values:[10]}]}),context) as any).reason,'invalid-data');
});
test('keeps category/value bindings, not just membership in a number set',()=>{
 assert.equal((readChartSubmission(submit({...data,series:[{...data.series[0],values:[20,10]}]}),context) as any).reason,'unverified-source');
 assert.equal((readChartSubmission(submit({...data,series:[{...data.series[0],values:[10,10]}]}),context) as any).reason,'unverified-source');
});
test('rejects numeric changes against a retrieved structured source',()=>{
 const url='https://example.com/forecast';const sourceData={...data,sources:[{kind:'url',label:'来源',url}]};
 const ctx={...context,evidence:[{url,value:{categories:['一月','二月'],values:[10,20]}}]};
 assert.ok(readChartSubmission(submit(sourceData),ctx).ok);
 assert.equal((readChartSubmission(submit({...sourceData,series:[{...data.series[0],values:[999,888]}]}),ctx) as any).reason,'unverified-source');
});
