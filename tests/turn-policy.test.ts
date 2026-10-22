import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveTurnPolicy,validateInlineChart} from '../src/mastra/agents/turn-policy';
const policy=(userText:string,extra={})=>resolveTurnPolicy({userText,...extra});
test('trend requests stay inline unless another delivery or required operation is explicit',()=>{
 assert.equal(policy('给我出一个苏州往后七天的天气趋势图').deliveryMode,'inline-chart');
 assert.equal(policy('不要 dashboard，只要折线图').deliveryMode,'inline-chart');
 assert.equal(policy('制作天气dashboard').deliveryMode,'html-artifact');
 assert.equal(policy('导出天气趋势图为PDF').deliveryMode,'file-artifact');
 assert.equal(policy('给我趋势图，同时下载HTML文件').deliveryMode,'mixed');
 assert.equal(policy('分析一下天气').deliveryMode,'general');
 assert.equal(policy('做个报表').deliveryMode,'general');
 assert.equal(policy('读取附件数据生成趋势图',{hasAttachments:true}).allowArtifactWrites,true);
 assert.equal(policy('生成趋势图',{selectedSkillIds:['one']}).allowArtifactWrites,true);
 assert.equal(policy('保存数据并生成趋势图').allowArtifactWrites,true);
});
test('followups inherit only a confirmed chart delivery and new instructions override',()=>{
 assert.equal(policy('改成柱状图',{previousDeliveryMode:'inline-chart'}).deliveryMode,'inline-chart');
 assert.equal(policy('导出HTML',{previousDeliveryMode:'inline-chart'}).deliveryMode,'html-artifact');
 assert.equal(policy('删除文件',{previousDeliveryMode:'inline-chart'}).deliveryMode,'general');
});
test('chart completion requires closed strict JSON and actual matching data series',()=>{
 assert.deepEqual(validateInlineChart('我已写好了html'),{ok:false,reason:'missing-chart'});
 assert.equal(validateInlineChart('```echarts\n{xAxis:{},series:[]}\n```').ok,false);
 assert.equal(validateInlineChart('```echarts\n{"series":[{"type":"line","data":[1,2]}],"xAxis":{"data":["a","b"]},"yAxis":{}}\n```').ok,true);
 assert.equal(validateInlineChart('```echarts\n{"series":[{"type":"line","data":[1]}],"xAxis":{"data":["a","b"]},"yAxis":{}}\n```').ok,false);
 assert.equal(validateInlineChart('```echarts\n{"series":[]}').ok,false);
 assert.equal(validateInlineChart('```echarts\n{"series":[{"type":"line","data":[1e999]}]}\n```').ok,false);
});
test('style-only followups inherit a confirmed inline chart but concept questions do not restrict tools',()=>{
 assert.equal(policy('换成红色',{previousDeliveryMode:'inline-chart'}).deliveryMode,'inline-chart');
 assert.equal(policy('解释什么是趋势图').deliveryMode,'general');
 assert.equal(policy('不要保存文件，只给我趋势图').deliveryMode,'inline-chart');
});
test('a chart plus scheduling, notification or other actions retains operational tools',()=>{
 for(const text of ['给我天气趋势图，并每天早上八点提醒我查看','生成趋势图并设置定时任务','折线图并发邮件给同事','画图并修改数据库'])assert.equal(policy(text).allowArtifactWrites,true,text);
});
test('completion rejects missing cartesian axes and unsupported series types',()=>{
 for(const option of [{series:[{type:'line',data:[1,2]}]},{series:[{type:'nonexistent',data:[1,2]}]}])assert.equal(validateInlineChart('```echarts\n'+JSON.stringify(option)+'\n```').ok,false);
});
test('accepted cartesian and pie fixtures render using the actual frontend ECharts runtime',async()=>{
 const {createRequire}=await import('node:module');const {init}=createRequire(new URL('../web/package.json',import.meta.url))('echarts');
 for(const option of [{xAxis:{type:'category',data:['a','b']},yAxis:{},series:[{type:'line',data:[1,2]}]},{series:[{type:'pie',data:[{name:'a',value:1}]}]}]){
  assert.equal(validateInlineChart('```echarts\n'+JSON.stringify(option)+'\n```').ok,true);
  const chart=init(null,undefined,{renderer:'svg',ssr:true,width:640,height:360});
  try{chart.setOption(option);assert.match(chart.renderToSVGString(),/<svg/);assert.equal(chart.getOption().series.length,1);}finally{chart.dispose();}
 }
});
