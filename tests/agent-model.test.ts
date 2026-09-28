import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

test('agent default model uses DeepSeek', () => {
  const source = readFileSync(new URL('../src/mastra/agents/agent.ts', import.meta.url), 'utf8');
  assert.match(source, /model:\s*'deepseek\/deepseek-v4-flash'/);
  assert.doesNotMatch(source, /model:\s*'openai\/gpt-5\.6-terra'/);
});

test('env example documents DEEPSEEK_API_KEY', () => {
  const envExample = readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
  assert.match(envExample, /DEEPSEEK_API_KEY=/);
});

test('web package depends on playground-ui and mastra react', () => {
  const pkg = JSON.parse(readFileSync(new URL('../web/package.json', import.meta.url), 'utf8')) as {
    dependencies: Record<string, string>;
  };
  assert.ok(pkg.dependencies['@mastra/playground-ui']);
  assert.ok(pkg.dependencies['@mastra/react']);
  assert.ok(pkg.dependencies['@mastra/client-js']);
  assert.ok(pkg.dependencies['@tanstack/react-query']);
  assert.ok(pkg.dependencies.tailwindcss);
});
