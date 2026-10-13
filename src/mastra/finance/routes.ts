import { registerApiRoute } from '@mastra/core/server';
import { financeCategories } from './catalog';
import { isFinanceEnabled } from './scope';

export const financeRoutes = [registerApiRoute('/finance/capabilities', {
  method: 'GET',
  handler: async context => {
    const user = (context.get('requestContext') as { get(key: string): unknown } | undefined)?.get('user') as
      { id?: string } | undefined;
    if (!user?.id) return context.json({ error: '未登录' }, 401);
    return context.json({ enabled: isFinanceEnabled(), categories: financeCategories });
  },
})];
