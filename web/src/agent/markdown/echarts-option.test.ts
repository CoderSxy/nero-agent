// @vitest-environment node
import { describe, expect, it } from 'vitest';
import * as echarts from 'echarts';
import { isEChartsCode, parseEChartsOption, parseEChartsResult } from './echarts-option';

const base = { xAxis: { type: 'category', data: ['一月', '二月'] }, yAxis: { type: 'value' },
  series: [{ type: 'line', data: [1, 2] }] };

describe('ECharts data parsing', () => {
  it('accepts strict JSON, JSON5 and one outer object wrapper', () => {
    expect(parseEChartsOption(JSON.stringify(base))).toEqual(base);
    const json5 = "{ /* chart */ xAxis:{type:'category',data:['一月','二月',]}, yAxis:{type:'value'}, series:[{type:'line',data:[1,2],}], }";
    expect(parseEChartsOption(json5)).toEqual(base);
    expect(parseEChartsOption(`(${json5})`)).toEqual(base);
  });
  it('normalizes only raw string newlines and preserves comments, quotes and escaped continuations', () => {
    const value = `{ // a comment with ' and "\n tooltip: {formatter: "{b}\n记录数: {c}"}, series: [] }`;
    expect(parseEChartsOption(value)).toEqual({ tooltip: { formatter: '{b}\n记录数: {c}' }, series: [] });
    expect(parseEChartsOption('{tooltip:{formatter:"a\\\r\nb"},series:[]}'))
      .toEqual({ tooltip: { formatter: 'ab' }, series: [] });
    expect(parseEChartsOption('{tooltip:{formatter:"a\\\"\nb"},series:[]}'))
      .toEqual({ tooltip: { formatter: 'a"\nb' }, series: [] });
    expect(parseEChartsOption('{tooltip:{formatter:"a\r\nb"},series:[]}'))
      .toEqual({ tooltip: { formatter: 'a\r\nb' }, series: [] });
  });
  it('never evaluates functions, calls, assignments, getters or expressions', () => {
    const marker = '__nero_chart_executed__';
    for (const code of [
      `(()=>{globalThis.${marker}=true;return {series:[]}})()`,
      `{series:[],tooltip:{formatter:function(){globalThis.${marker}=true}}}`,
      `{series:[],tooltip:{formatter:()=>{globalThis.${marker}=true}}}`,
      `option={series:[]};globalThis.${marker}=true`,
      `{get series(){globalThis.${marker}=true;return []}}`,
      '{series:[],value:1+2}', '{series:[],value:`template`}',
    ]) {
      expect(parseEChartsOption(code), code).toBeNull();
      expect((globalThis as Record<string, unknown>)[marker]).toBeUndefined();
    }
  });
  it('rejects unsupported shapes, unsafe keys, nonfinite values and truncated input', () => {
    for (const code of ['null', '[]', '42', '{series:[', '{title:"unfinished}',
      '{series:[],foo:NaN}', '{series:[],foo:Infinity}', '{series:[],foo:1e999}',
      '{series:[],nested:{constructor:{}}}', '{series:[],nested:{__proto__:{}}}',
      '{series:[],nested:{prototype:{}}}', '(({series:[]}))']) {
      expect(parseEChartsOption(code), code).toBeNull();
    }
    expect(parseEChartsResult(' '.repeat(100_001))).toMatchObject({ ok: false, kind: 'limit' });
    expect(parseEChartsResult('[]')).toMatchObject({ ok: false, kind: 'structure' });
    expect(parseEChartsResult('{series:')).toMatchObject({ ok: false, kind: 'syntax' });
  });
  it('recognizes a single series but does not turn ordinary JSON into a chart', () => {
    expect(isEChartsCode(JSON.stringify({ ...base, series: base.series[0] }))).toBe(true);
    expect(isEChartsCode("{series:[{type:'line',data:[1,2]}]}" )).toBe(true);
    expect(isEChartsCode('{"xAxis":{},"value":3}')).toBe(false);
    expect(isEChartsCode('{"series":"notes"}')).toBe(false);
  });
  it.each(['line', 'bar'])('renders parsed %s options with real ECharts SVG SSR', type => {
    const option = parseEChartsOption(JSON.stringify({ ...base, animation: false, series: { type, data: [1, 2] } }));
    expect(option).not.toBeNull();
    const chart = echarts.init(null, undefined, { renderer: 'svg', ssr: true, width: 640, height: 360 });
    try { chart.setOption(option!); expect(chart.renderToSVGString()).toContain('<svg'); }
    finally { chart.dispose(); }
  });
});
