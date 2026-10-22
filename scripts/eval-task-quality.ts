import { mkdirSync, writeFileSync } from 'node:fs';
import { evaluationExitCode, runQualityEvaluation } from '../src/mastra/agents/task-quality/evaluation.ts';

const live = process.argv.includes('--live');
if (process.env.npm_lifecycle_event === 'eval:task-quality:live' && !live) {
  console.error('eval:task-quality:live 必须显式传入 --live');
  process.exit(1);
}
const report = await runQualityEvaluation({ mode: live ? 'live' : 'fixture', maxMainModelCalls: 60, modelRefs: (process.env.EVAL_LIVE_MODEL_REFS ?? '').split(',').map(s => s.trim()).filter(Boolean) });
const directory = 'docs/superpowers/verification';
mkdirSync(directory, { recursive: true });
const jsonPath = `${directory}/2026-10-22-agent-phase-one-task-quality-eval.json`;
writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
const lines = [
  `# 任务质量评测 ${report.mode}`,
  '',
  `- passed: ${report.passed}`,
  `- skipped: ${report.skipped}`,
  `- blocked: ${report.blocked}`,
  `- hardFailures: ${report.hardFailures}`,
  `- price: null`,
  `- elapsedMs: ${report.elapsedMs}`,
  '',
  ...report.cases.map(item => `- ${item.caseId}: ${item.blocked ? 'blocked' : item.passed ? 'passed' : 'failed'} actual=${item.actualStatus} modelCalls=${item.modelCalls}${item.reason ? ` (${item.reason})` : ''}`),
  '',
];
writeFileSync(`${directory}/2026-10-22-agent-phase-one-task-quality-eval.md`, lines.join('\n'));
console.log(`${report.mode} passed=${report.passed} blocked=${report.blocked} hardFailures=${report.hardFailures}`);
process.exit(evaluationExitCode(report));
