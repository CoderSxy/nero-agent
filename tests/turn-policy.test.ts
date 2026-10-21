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
