import { createTool } from '@mastra/core/tools';
import { chartSubmissionSchema } from './chart-data';

/** Pure value handoff for compatible gateways that ignore response_format. */
export const submitChartDataTool = createTool({
  id: 'submit_chart_data',
  description: '提交本轮已取得的结构化图表或天气数据，由平台校验来源并绘图。天气提交使用 schemaVersion 2，包含地点、日期、天气代码和字段来源；不能联网或读写文件，不生成 HTML、字符图或 ECharts 代码。数据不足时提交 insufficient-data。',
  inputSchema: chartSubmissionSchema,
  execute: async input => input,
});
