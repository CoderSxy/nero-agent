export const financeCategories = ['all', 'a_stock', 'fund', 'index', 'macro', 'futures'] as const;
export type FinanceCategory = typeof financeCategories[number];
export type FinanceParameter = { required: boolean; kind: 'code' | 'date' | 'choice' | 'contract'; choices?: readonly string[]; description: string };
export type FinanceInterface = {
  name: string; category: Exclude<FinanceCategory, 'all'>; description: string; source: string;
  parameters: Record<string, FinanceParameter>; outputFields: readonly string[];
  units: Record<string, string>; maxRows: number; maxRangeDays?: number; ttlSeconds: number;
};

const period: FinanceParameter = { required: false, kind: 'choice', choices: ['daily', 'weekly', 'monthly'], description: '周期，默认 daily' };
const date: FinanceParameter = { required: true, kind: 'date', description: 'YYYYMMDD 日期' };
const code: FinanceParameter = { required: true, kind: 'code', description: '6 位代码' };

function validDate(value: string): boolean {
  if (!/^\d{8}$/.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(4, 6));
  const day = Number(value.slice(6));
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() + 1 === month && parsed.getUTCDate() === day;
}

export const financeCatalog: readonly FinanceInterface[] = [
  { name: 'stock_zh_a_hist', category: 'a_stock', description: '沪深京 A 股历史行情', source: '东方财富',
    parameters: { symbol: code, period, start_date: date, end_date: date,
      adjust: { required: false, kind: 'choice', choices: ['', 'qfq', 'hfq'], description: '复权方式，默认不复权' } },
    outputFields: ['日期', '开盘', '收盘', '最高', '最低', '成交量', '成交额', '涨跌幅'],
    units: { 成交量: '手', 成交额: '元', 涨跌幅: '%' }, maxRows: 100, maxRangeDays: 366, ttlSeconds: 900 },
  { name: 'fund_open_fund_info_em', category: 'fund', description: '开放式基金单位净值走势', source: '东方财富/天天基金',
    parameters: { symbol: code, indicator: { required: true, kind: 'choice', choices: ['单位净值走势'], description: '首版仅支持单位净值走势' } },
    outputFields: ['净值日期', '单位净值', '日增长率'], units: { 日增长率: '%' }, maxRows: 100, ttlSeconds: 3600 },
  { name: 'index_zh_a_hist', category: 'index', description: '中国股票指数历史行情', source: '东方财富',
    parameters: { symbol: code, period, start_date: date, end_date: date },
    outputFields: ['日期', '开盘', '收盘', '最高', '最低', '成交量', '成交额'],
    units: { 成交量: '手', 成交额: '元' }, maxRows: 100, maxRangeDays: 366, ttlSeconds: 900 },
  { name: 'macro_china_cpi', category: 'macro', description: '中国居民消费价格指数月度数据', source: '东方财富',
    parameters: {}, outputFields: ['月份', '全国-当月', '全国-同比增长', '全国-环比增长'],
    units: { '全国-同比增长': '%', '全国-环比增长': '%' }, maxRows: 100, ttlSeconds: 86400 },
  { name: 'futures_zh_daily_sina', category: 'futures', description: '新浪财经期货日线，支持具体或连续合约', source: '新浪财经',
    parameters: { symbol: { required: true, kind: 'contract', description: '期货合约代码，例如 RB0' } },
    outputFields: ['date', 'open', 'high', 'low', 'close', 'volume', 'hold', 'settle'],
    units: {}, maxRows: 100, ttlSeconds: 3600 },
];

export function isFinanceCategory(value: unknown): value is FinanceCategory {
  return typeof value === 'string' && financeCategories.includes(value as FinanceCategory);
}

export function getFinanceInterface(name: string, category: FinanceCategory): FinanceInterface | null {
  return financeCatalog.find(item => item.name === name && (category === 'all' || item.category === category)) ?? null;
}

export function searchFinanceCatalog(query: string, category: FinanceCategory, limit = 5): FinanceInterface[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const aliases: Record<Exclude<FinanceCategory, 'all'>, string> = {
    a_stock: '股票 股价 个股 a股 股票代码 股市 A股',
    fund: '基金 净值 基金代码',
    index: '指数 大盘 沪指 深指',
    macro: '宏观 cpi 物价 通胀 消费者价格',
    futures: '期货 合约 商品期货',
  };
  return financeCatalog.filter(item => category === 'all' || item.category === category)
    .map(item => ({ item, score: terms.reduce((sum, term) => sum + (item.name.toLowerCase().includes(term) ? 3 : 0)
      + (item.description.toLowerCase().includes(term) ? 2 : 0) + (aliases[item.category].includes(term) ? 1 : 0), 0) }))
    .filter(entry => !terms.length || entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.min(Math.max(limit, 1), 5)).map(entry => entry.item);
}

export function validateFinanceParameters(item: FinanceInterface, input: Record<string, unknown>): Record<string, string> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('参数必须是对象');
  const result: Record<string, string> = {};
  for (const key of Object.keys(input)) if (!(key in item.parameters)) throw new Error(`不支持参数 ${key}`);
  for (const [key, rule] of Object.entries(item.parameters)) {
    const value = input[key];
    if (value === undefined || value === null) {
      if (rule.required) throw new Error(`缺少参数 ${key}`);
      continue;
    }
    if (typeof value !== 'string') throw new Error(`参数 ${key} 必须是字符串`);
    const valid = rule.kind === 'code' ? /^\d{6}$/.test(value)
      : rule.kind === 'date' ? validDate(value)
        : rule.kind === 'contract' ? /^[A-Za-z]{1,3}\d{1,4}$/.test(value)
          : rule.choices?.includes(value) ?? false;
    if (!valid) throw new Error(`参数 ${key} 无效`);
    result[key] = value;
  }
  if (item.maxRangeDays) {
    const start = result.start_date, end = result.end_date;
    if (!start || !end) throw new Error('必须指定日期范围');
    const toTime = (value: string) => Date.UTC(Number(value.slice(0, 4)), Number(value.slice(4, 6)) - 1, Number(value.slice(6)));
    const days = (toTime(end) - toTime(start)) / 86400000;
    if (days < 0 || days > item.maxRangeDays) throw new Error(`日期范围不可超过 ${item.maxRangeDays} 天`);
  }
  return result;
}
