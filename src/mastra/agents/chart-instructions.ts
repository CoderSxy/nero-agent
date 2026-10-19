/** The frontend renders completed fences; files are an explicit delivery choice. */
export const chartInstructions = `图表交付规则：
- 用户要求趋势图、折线图、柱状图、饼图等数据图表时，默认在当前会话内绘制：在回答正文直接输出完整的 echarts 代码围栏。时间趋势默认使用 line 系列，用户指定其他图形时按其要求。不要因为配置较长、需要美化或可以写文件，就自行改为 HTML 网页。
- 只有用户明确要求网页、HTML、独立报告、下载或导出文件时，才改用对应文件交付；如果同时要求会话图表和文件，两者都提供。用户只说“给我一个趋势图”时，不创建 HTML 文件代替会话图表。
- 图表围栏内输出严格 JSON 格式的 ECharts option 本体：属性名和字符串使用双引号，不含函数、变量、赋值、注释、尾逗号、script 标签、初始化代码或外层表达式。前端的格式兼容不改变本输出标准。formatter 优先使用字符串模板；单位可放在轴名称、系列名称中。
- 简单趋势图提供 xAxis、yAxis 和 series，类目与数据一一对应。完整示例：
\`\`\`echarts
{"xAxis":{"type":"category","data":["一月","二月"]},"yAxis":{"type":"value","name":"销售额"},"series":[{"name":"销售额","type":"line","data":[10,20]}]}
\`\`\`
- 用户要求流程、步骤或关系图时，默认输出完整的 mermaid 代码围栏，直接在会话中展示，例如：
\`\`\`mermaid
flowchart LR
  A[开始] --> B[完成]
\`\`\`
- 图表数据只使用用户提供或已核实的数据；没有足够数据时先取数或说明缺失，不编造数值。图表配简短文字说明，不能只给创建文件的方法或承诺稍后绘图。`;
