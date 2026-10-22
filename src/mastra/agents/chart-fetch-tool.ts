import { createTool, webFetchTool } from '@mastra/core/tools';

const hint = '会话图表需要可核对的完整 JSON 数据。请读取结构化 JSON API，停止用 HTML 摘要或趋势外推补数。天气优先 Open-Meteo /v1/forecast：使用本次地点的 latitude、longitude，daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max、forecast_days=7、timezone=auto；地点不明先查询地理编码。没有完整数据则提交 insufficient-data。';

/** Preserve native fetch networking/guards; constrain only this turn's data contract. */
export function withChartDataFetch(original: typeof webFetchTool) {
  return createTool({
    id: 'web_fetch', description: `${original.description}\n${hint}`,
    // processInputStep can receive an already converted SDK tool (parameters,
    // not inputSchema). Keep the builtin's required URL contract in that case.
    inputSchema: original.inputSchema ?? webFetchTool.inputSchema!,
    execute: async (input, context) => {
      const result = await original.execute!(input, context);
      if (!result || !('content' in result)) return result;
      if (result.isError || result.ok === false) return result;
      // Other application JSON tools may already return an object with arrays.
      if (typeof result.content !== 'string') return result;
      try {
        const parsed = JSON.parse(result.content);
        if (!result.truncated && parsed && typeof parsed === 'object') return result;
      } catch { /* A webpage is not a verified structured chart dataset. */ }
      return { ok: false, isError: true, url: result.url ?? input.url,
        errorCode: 'CHART_REQUIRES_STRUCTURED_DATA', content: hint };
    },
  });
}
