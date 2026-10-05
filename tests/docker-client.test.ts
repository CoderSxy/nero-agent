import assert from 'node:assert/strict';
import test from 'node:test';
import { PassThrough } from 'node:stream';
import type Docker from 'dockerode';
import { createDockerodeEngine } from '../src/mastra/sandbox/docker/client';

test('timed out docker exec stops its container before releasing the command', async () => {
  const stream = new PassThrough();
  let stops = 0;
  const container = {
    exec: async () => ({ start: async () => stream, inspect: async () => ({ ExitCode: null }) }),
    stop: async () => { stops += 1; },
    modem: { demuxStream: () => undefined },
  };
  const docker = {
    getContainer: () => container,
  } as unknown as Docker;
  const engine = await createDockerodeEngine(docker);
  await assert.rejects(
    engine.exec('container-1', 'sleep', ['999'], { cwd: '/workspace/threads/t', timeoutMs: 10 }),
    /timed out/,
  );
  assert.equal(stops, 1);
});
