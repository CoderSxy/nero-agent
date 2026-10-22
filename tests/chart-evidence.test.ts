import test from 'node:test';import assert from 'node:assert/strict';
import {collectChartEvidence,matchesUserData,matchesStructuredData} from '../src/mastra/agents/chart-evidence';
const weather={categories:['10/22','10/23','10/24','10/25','10/26','10/27','10/28'],series:[{name:'最高温',unit:'℃',values:[19,22,24,27,24,19,18]},{name:'最低温',unit:'℃',values:[12,17,19,20,16,13,14]}],sources:[]} as any;
test('preserves named temperature arrays from user input and structured forecast JSON',()=>{
 assert.ok(matchesUserData(weather,'日期10/22至10/28，最高温19,22,24,27,24,19,18，最低温12,17,19,20,16,13,14'));
 assert.ok(matchesStructuredData(weather,{content:JSON.stringify({daily:{time:weather.categories,temperature_2m_max:weather.series[0].values,temperature_2m_min:weather.series[1].values}})}));
 assert.equal(matchesStructuredData({...weather,series:[weather.series[1],{...weather.series[0],values:weather.series[1].values}]},{daily:{time:weather.categories,temperature_2m_max:weather.series[0].values,temperature_2m_min:weather.series[1].values}}),false);
});
test('a query echo and empty results never create a successful source',()=>{
 assert.deepEqual(collectChartEvidence({query:'https://example.com/fake',results:[]}),[]);
 assert.deepEqual(collectChartEvidence({ok:false,url:'https://example.com/fake'}),[]);
 assert.equal(collectChartEvidence({results:[{url:'https://example.com/real',content:'data'}]})[0].url,'https://example.com/real');
});
test('an explicit user date range cannot be silently reordered',()=>{
 const swapped={...weather,categories:['10/22','10/24','10/23','10/25','10/26','10/27','10/28']};
 assert.equal(matchesUserData(swapped,'日期10/22至10/28，最高温19,22,24,27,24,19,18，最低温12,17,19,20,16,13,14'),false);
});
test('cannot pair categories from one returned dataset with values from another',()=>{
 const input={categories:['一月','二月'],series:[{name:'值',unit:'',values:[30,40]}],sources:[]} as any;
 assert.equal(matchesStructuredData(input,{first:{categories:['一月','二月'],values:[10,20]},second:{categories:['三月','四月'],values:[30,40]}}),false);
});
