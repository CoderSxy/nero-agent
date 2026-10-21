export type TurnDeliveryMode = 'inline-chart' | 'html-artifact' | 'file-artifact' | 'mixed' | 'general';
export type TurnPolicy = { deliveryMode: TurnDeliveryMode; confidence: 'high' | 'uncertain'; allowArtifactWrites: boolean };
export function resolveTurnPolicy(input: { userText: string; previousDeliveryMode?: TurnDeliveryMode; hasAttachments?: boolean; selectedSkillIds?: string[] }): TurnPolicy {
  // Remove explicit negations before matching positive delivery requests.
  const text = input.userText.replace(/(?:不要|无需|不需要|别|不用)\s*(?:生成|创建|制作|写入)?\s*(?:HTML|网页|dashboard|看板|文件|报表)/gi, '');
  const chart = /趋势图|折线图|柱状图|饼图|散点图|画图|图表/.test(text);
  const html = /html|dashboard|网页|看板/i.test(text);
  const file = /pdf|xlsx|excel|csv|pptx|下载|导出|保存|写入/i.test(text);
  const both = chart && /同时|另外|也要|并且|还要/.test(text) && (html || file);
  let deliveryMode: TurnDeliveryMode = both ? 'mixed' : html ? 'html-artifact' : file ? 'file-artifact' : chart ? 'inline-chart' : 'general';
  // Never remove computation / file / skill tools on mixed or ambiguous tasks.
  const complex = input.hasAttachments || !!input.selectedSkillIds?.length || /附件|上传|读取|文件|脚本|运行|执行|安装|保存|写入|删除|修改代码|skill|技能/i.test(text);
  if (deliveryMode === 'inline-chart' && complex) deliveryMode = 'mixed';
  const inline = deliveryMode === 'inline-chart';
  return { deliveryMode, confidence: inline || html || file ? 'high' : 'uncertain', allowArtifactWrites: !inline };
}

export function validateInlineChart(text: string): { ok: boolean; reason?: 'missing-chart' | 'invalid-json' | 'invalid-option' } {
  const fences = [...text.matchAll(/^ {0,3}(`{3,}|~{3,})echarts\s*\n([\s\S]*?)\n {0,3}\1[ \t]*$/gm)];
  if (!fences.length) return { ok: false, reason: 'missing-chart' };
  for (const fence of fences) {
    if (fence[2].length > 100_000) return { ok: false, reason: 'invalid-option' };
    let option: any;
    try { option = JSON.parse(fence[2]); } catch { return { ok: false, reason: 'invalid-json' }; }
    const pending = [option];
    while (pending.length) {
      const value = pending.pop();
      if (typeof value === 'number' && !Number.isFinite(value)) return { ok: false, reason: 'invalid-option' };
      if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) {
        if (['__proto__', 'prototype', 'constructor'].includes(key)) return { ok: false, reason: 'invalid-option' };
        pending.push(child);
      }
    }
    const series = Array.isArray(option?.series) ? option.series : [option?.series];
    if (!series.length || series.some((s: any) => !s || typeof s.type !== 'string')) return { ok: false, reason: 'invalid-option' };
    const datasets = Array.isArray(option?.dataset) ? option.dataset : [option?.dataset];
    if (series.some((s: any) => !Array.isArray(s.data) || !s.data.length)) {
      if (!datasets.some((d: any) => Array.isArray(d?.source) && d.source.length > 1)) return { ok: false, reason: 'invalid-option' };
    }
    const axes = Array.isArray(option?.xAxis) ? option.xAxis : [option?.xAxis];
    for (const s of series) {
      const categories = axes[s.xAxisIndex ?? 0]?.data;
      if (Array.isArray(categories) && Array.isArray(s.data) && categories.length !== s.data.length) return { ok: false, reason: 'invalid-option' };
    }
  }
  return { ok: true };
}
