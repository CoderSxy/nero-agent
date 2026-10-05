import assert from 'node:assert/strict';
import test from 'node:test';
import { agentModelLockMiddleware, isAgentModelOverrideRequest } from '../src/mastra/agent-model-lock';
import { redactSecrets } from '../src/mastra/models/redact';

async function run(method: string, path: string, body?: unknown) {
  let nextCalled = false;
  const raw = new Request(`http://localhost${path}`, {
    method,
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const result = await agentModelLockMiddleware.handler({ req: { method, path, raw } }, async () => {
    nextCalled = true;
  });
  return { nextCalled, result };
}

test('mutating agent model routes are rejected with 403 JSON', async () => {
  const blocked: Array<[string, string]> = [
    ['POST', '/api/agents/agent/model'],
    ['POST', '/api/agents/agent/model/reset'],
    ['POST', '/api/agents/agent/models/reorder'],
    ['POST', '/api/agents/agent/models/abc'],
    ['PUT', '/api/agents/agent/models/abc'],
    ['PATCH', '/api/agents/agent/model'],
    ['DELETE', '/api/agents/agent/models/abc'],
    ['post', '/api/agents/agent/model'],
  ];
  for (const [method, path] of blocked) {
    const { nextCalled, result } = await run(method, path);
    assert.equal(nextCalled, false, `${method} ${path} must not reach next`);
    assert.ok(result instanceof Response);
    assert.equal(result.status, 403);
    assert.match(result.headers.get('content-type') ?? '', /application\/json/);
    const body = (await result.json()) as { error?: string };
    assert.equal(typeof body.error, 'string');
  }
});

test('execution requests cannot override catalog models', async () => {
  for (const path of ['/api/agents/agent/generate', '/api/agents/agent/stream', '/api/agents/agent/stream/vnext', '/api/agents/agent/resume-stream']) {
    for (const body of [
      { messages: 'hi', model: 'other/model' },
      { messages: 'hi', structuredOutput: { schema: {}, model: 'other/model' } },
    ]) {
      const { nextCalled, result } = await run('POST', path, body);
      assert.equal(nextCalled, false, path);
      assert.equal(result?.status, 403);
    }
  }
  assert.equal((await run('POST', '/api/agents/agent/stream', { messages: 'hi' })).nextCalled, true);
  const idleMessage = await run('POST', '/api/agents/agent/send-message', {
    message: 'hi', resourceId: 'r', threadId: 't',
    ifIdle: { streamOptions: { model: 'other/model' } },
  });
  assert.equal(idleMessage.nextCalled, false);
  assert.equal(idleMessage.result?.status, 403);
});

test('read requests and unrelated agent routes pass through', async () => {
  const allowed: Array<[string, string]> = [
    ['GET', '/api/agents/agent/model'],
    ['GET', '/api/agents/agent/models'],
    ['GET', '/api/agents'],
    ['POST', '/api/agents/agent/stream'],
    ['POST', '/api/agents/agent/generate'],
    ['POST', '/api/models'],
    ['POST', '/api/agent-controller/c/sessions/r/model'],
  ];
  for (const [method, path] of allowed) {
    const { nextCalled, result } = await run(method, path);
    assert.equal(nextCalled, true, `${method} ${path} must reach next`);
    assert.equal(result, undefined);
  }
  assert.equal(isAgentModelOverrideRequest('GET', '/api/agents/agent/model'), false);
});

test('redactSecrets masks API key shaped tokens', () => {
  const key = 'sk-' + 'a1B2c3D4e5F6g7H8';
  const long = 'x'.repeat(40);
  const text = `failed with key ${key} and Authorization: Bearer ${'t'.repeat(24)} token ${long}`;
  const redacted = redactSecrets(text);
  assert.ok(!redacted.includes(key));
  assert.ok(!redacted.includes(long));
  assert.ok(!redacted.includes('t'.repeat(24)));
  assert.match(redacted, /sk-\*\*\*/);
  assert.equal(redactSecrets('plain error message'), 'plain error message');
});
