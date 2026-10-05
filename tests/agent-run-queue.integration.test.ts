import test from 'node:test';

test('agent-run isolation is not claimed until native stream/approval can be wrapped', t => {
  t.skip('Mastra stream/approve/resume lifecycle is not wrapped; only command-level ExecutionQueue is active');
});
