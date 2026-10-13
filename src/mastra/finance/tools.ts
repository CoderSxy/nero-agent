import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import type { RequestContext } from '@mastra/core/request-context';
import { getFinanceInterface, searchFinanceCatalog, validateFinanceParameters } from './catalog';
import { fetchFinanceData } from './aktools-client';
import { isFinanceEnabled, trustedFinanceCategory } from './scope';
import { trustedUserFrom } from '../models/resolver';

function categoryFor(context: RequestContext | undefined) {
  if (!isFinanceEnabled() || !context) throw new Error('当前会话未启用财经数据');
  trustedUserFrom(context);
  const category = trustedFinanceCategory(context);
  if (!category) throw new Error('当前会话未启用财经数据');
  return category;
}

export const financeSearchTool = createTool({
  id: 'finance_search', description: '搜索当前会话分类内支持的 AKShare 财经数据接口，最多返回 5 项。',
  inputSchema: z.object({ query: z.string().trim().min(1).max(100), limit: z.number().int().min(1).max(5).default(5) }),
  execute: async ({ query, limit }, { requestContext }) => {
    const category = categoryFor(requestContext);
    return { category, matches: searchFinanceCatalog(query, category, limit).map(({ name, description, source }) =>
      ({ name, description, source })) };
  },
});

export const financeInterfaceInfoTool = createTool({
  id: 'finance_interface_info', description: '读取当前财经分类内指定 AKShare 接口的参数、来源与返回字段。',
  inputSchema: z.object({ name: z.string().min(1).max(80) }),
  execute: async ({ name }, { requestContext }) => {
    const category = categoryFor(requestContext);
    const item = getFinanceInterface(name, category);
    if (!item) throw new Error('接口不存在或不属于当前财经分类');
    return item;
  },
});

export const financeFetchTool = createTool({
  id: 'finance_fetch', description: '用已核验的接口与参数从 AKTools 获取财经数据。先调用 finance_interface_info；不得猜测接口名或数据。',
  inputSchema: z.object({ name: z.string().min(1).max(80), parameters: z.record(z.string(), z.string()).default({}) }),
  execute: async ({ name, parameters }, { requestContext }) => {
    const category = categoryFor(requestContext);
    const item = getFinanceInterface(name, category);
    if (!item) throw new Error('接口不存在或不属于当前财经分类');
    return fetchFinanceData(item, validateFinanceParameters(item, parameters));
  },
});
