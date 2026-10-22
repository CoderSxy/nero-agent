import {createTool, askUserTool} from '@mastra/core/tools';
/** Only resolve an already-decided delivery format, never data/permission questions. */
export function withChartDeliveryQuestionPolicy(original:typeof askUserTool){
 return createTool({
  id:'ask_user',description:original.description,
  inputSchema:original.inputSchema??askUserTool.inputSchema!,suspendSchema:original.suspendSchema??askUserTool.suspendSchema,resumeSchema:original.resumeSchema??askUserTool.resumeSchema,
  execute:async(input,context)=>{
   const labels=input.options?.map(o=>o.label).join(' ')??'';
   const formatQuestion=/产出|输出|格式|交付|图表形态|哪种|format|deliver/i.test(input.question)
    && /echarts/i.test(input.question+' '+labels)
    && /html|svg|png|chart\.js|网页|文件/i.test(input.question+' '+labels);
   if(formatQuestion)return {content:'平台已确定本轮交付方式：当前会话内的 ECharts 图表，无需用户确认输出形式，不需要 HTML 或 CDN。请用 submit_chart_data 提交已提供或已核实的数据与来源，平台负责生成 option JSON 并成图。',isError:false};
   return original.execute?.(input,context);
  },
 });
}
