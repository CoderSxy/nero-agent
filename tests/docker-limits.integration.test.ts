import test from 'node:test';

test('live docker pids/memory/cpu/timeout/network limits', async t => {
  t.skip('Requires SANDBOX_DOCKER_INTEGRATION=true and a pinned SANDBOX_IMAGE digest on the host');
});
