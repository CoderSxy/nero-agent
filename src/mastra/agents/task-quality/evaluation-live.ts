import { randomUUID } from 'node:crypto';
import { RequestContext } from '@mastra/core/request-context';
import { getActiveUserById } from '../../auth/service';
import { getPool } from '../../auth/db';
import { bindSkillServerExecutionId, bindSkillThreadId } from '../../skills/execution-context';
import { chatModelRefContextKey } from '../../models/resolver';
import { getTaskRuntime } from './runtime';
import { TASK_OUTCOME_CONTEXT_KEY } from './processor';
import type { TaskOutcome } from './types';

/** Explicit opt-in: uses the selected existing model under a designated test user.
 * No supplied arbitrary API key, implicit account or provider switching. */
export async function runLiveAgent(item: {id:string;userText:string}, modelRef: string, remaining: number, signal?: AbortSignal) {
  const userId=process.env.EVAL_LIVE_USER_ID;
  if(!userId) throw new Error('需要 EVAL_LIVE_USER_ID 指定测试用户');
  const user=await getActiveUserById(userId);
  if(!user) throw new Error('指定测试用户不存在或已禁用');
  const {mastra}=await import('../../index');
  const agent=mastra.getAgent('agent');
  const rc=new RequestContext();rc.set('mastra__user',user);rc.set(chatModelRefContextKey,modelRef);
  const runId=bindSkillServerExecutionId(rc), threadId=`quality-eval-${randomUUID()}`;
  bindSkillThreadId(rc,threadId);
  const memory=await agent.getMemory({requestContext:rc});
  if(!memory) throw new Error('评测需要已有持久化会话存储');
  await memory.createThread({threadId,resourceId:user.id,title:`Quality evaluation: ${item.id}`});
  const runtime=getTaskRuntime(rc)!;runtime.enforce=true;runtime.suiteModelBudget={remaining};
  const negative=item.id==='weather-range-invalid';
  const prompt=negative
    ? '仅使用我提供的测试数据，不联网、不补数：上海 2025-01-01 最高温20°C、最低温10°C。请生成未来七天天气趋势，缺少数据时明确报告未完成。'
    : item.id==='file-request' ? '在当前测试会话创建 sales.csv，内容为 product,amount 换行 demo,1，提供文件链接。' : item.userText;
  try {
    await agent.generate(prompt,{requestContext:rc,runId,memory:{thread:threadId,resource:user.id},abortSignal:signal});
    const outcome=rc.get(TASK_OUTCOME_CONTEXT_KEY) as TaskOutcome|undefined;
    const row=await getPool().query<{main_calls:number;repair_calls:number;tool_calls:number}>('SELECT main_calls,repair_calls,tool_calls FROM app_agent_run_controls WHERE run_id=$1',[runId]);
    return {outcome, modelCalls:remaining-runtime.suiteModelBudget.remaining, repairCalls:Number(row.rows[0]?.repair_calls??0),toolCalls:Number(row.rows[0]?.tool_calls??0),notes:[`test-thread:${threadId}`,...negative?['live-model-with-user-data-fault']:[]]};
  } finally {
    // Keep the isolated test thread/files for audit; never delete an arbitrary
    // existing conversation or directory. Report its id so cleanup is explicit.
    await getPool().query("UPDATE app_agent_run_controls SET status=CASE WHEN status='active' THEN 'interrupted' ELSE status END WHERE run_id=$1",[runId]);
  }
}
