import assert from 'node:assert/strict';
import test from 'node:test';
import { getSkillRuntime, resetSkillRuntimeForTests, resolveSkillAgentProcessor, resolveSkillAgentTools } from '../src/mastra/skills/factory.ts';

const keys = ['AGENT_SKILLS_ENABLED', 'SKILLS_STORAGE_ROOT', 'DATABASE_URL'] as const;
async function isolated(operation: () => Promise<void>) {
  const before = new Map(keys.map(key => [key, process.env[key]]));
  resetSkillRuntimeForTests();
  try { await operation(); } finally {
    resetSkillRuntimeForTests();
    for (const [key, value] of before) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}

test('disabled skills hooks do not initialize a runtime or require storage/database config', () => isolated(async () => {
  delete process.env.AGENT_SKILLS_ENABLED;
  delete process.env.SKILLS_STORAGE_ROOT;
  delete process.env.DATABASE_URL;
  assert.deepEqual(resolveSkillAgentTools(), {});
  const processor = resolveSkillAgentProcessor();
  assert.equal(await processor.processInputStep({} as never), undefined);
  assert.equal(await processor.processLLMRequest({} as never), undefined);
  const messageList = {};
  assert.equal(processor.processOutputResult({ messageList } as never), messageList);
}));

test('enabled skills reject missing storage config instead of using a temporary fallback', () => isolated(async () => {
  process.env.AGENT_SKILLS_ENABLED = 'true';
  process.env.DATABASE_URL = 'postgresql://unused@localhost:5433/unused';
  delete process.env.SKILLS_STORAGE_ROOT;
  assert.throws(() => getSkillRuntime(), /SKILLS_STORAGE_ROOT/);
  assert.throws(() => resolveSkillAgentTools(), /SKILLS_STORAGE_ROOT/);
  process.env.SKILLS_STORAGE_ROOT = '/tmp/nero-skill-explicit-config-test';
  const runtime = getSkillRuntime();
  assert.match(runtime.releaseStore.resolveReleaseRoot('demo', 1, 'a'.repeat(64)), /^\/tmp\/nero-skill-explicit-config-test\/releases\//);
  assert.equal(getSkillRuntime(), runtime);
}));
