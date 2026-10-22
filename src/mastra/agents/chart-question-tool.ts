import {createTool, type askUserTool} from '@mastra/core/tools';
/** Only resolve an already-decided delivery format, never data/permission questions. */
export function withChartDeliveryQuestionPolicy(original:typeof askUserTool){
 return createTool({
  id:'ask_user',description:original.description,
  inputSchema:original.inputSchema!,suspendSchema:original.suspendSchema,resumeSchema:original.resumeSchema,
  execute:async(input,context)=>{
   const labels=input.options?.map(o=>o.label).join(' ')??'';
   const formatQuestion=/产出|输出|格式|交付|图表形态|哪种|format|deliver/i.test(input.question)
    && /echarts/i.test(input.question+' '+labels)
    && /html|svg|png|chart\.js|网页|文件/i.test(input.question+' '+labels);
   if(formatQuestion)return {content:'平台已确定本轮交付方式：当前会话内的 ECharts option JSON 围栏，无需用户确认输出形式，不需要 HTML 或 CDN。请按已提供或已核实的数据直接成图。',isError:false};
   return original.execute?.(input,context);
  },
 });
}
