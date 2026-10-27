import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

test('monitor metric failures always request service stop rather than exiting via set -e', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nero-monitor-'));
  try {
    await writeFile(join(dir, 'id'), '#!/bin/sh\necho 0\n', { mode: 0o755 });
    await writeFile(join(dir, 'systemctl'), `#!/bin/sh
if [ "$1" = stop ]; then echo stopped >> "$STOP_RECORD"; exit 0; fi
case "$*" in *nero-runtime-emergency.service*) exit 0;; esac
exit 1
`, { mode: 0o755 });
    const result = spawnSync('bash', ['scripts/ops/monitor.sh', '5'], {
      env: { ...process.env, PATH: dir + ':' + process.env.PATH, STOP_RECORD: join(dir, 'stopped') }, encoding: 'utf8',
    });
    assert.notEqual(result.status, 0);
    assert.match(await readFile(join(dir, 'stopped'), 'utf8').catch(() => ''), /stopped/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('all workload kinds receive the same parent and invocation; low host memory and stale reuse are refused', async () => {
  const { createWorkloadPolicy, WORKLOAD_SLICE } = await import('../src/mastra/sandbox/workload-policy');
  const env = { NERO_RESOURCE_GUARD_ENABLED: 'true', INVOCATION_ID: 'a'.repeat(32) };
  const snapshot = { available: 1024 * 1024 * 1024, runtimeCurrent: 100 * 1024 * 1024,
    runtimeMax: 960 * 1024 * 1024, workloadsCurrent: 0, workloadsMax: 512 * 1024 * 1024, tripped: false };
  const policy = createWorkloadPolicy(env, async () => snapshot);
  for (const label of ['nero.sandbox', 'nero.skill-run', 'nero.skill-readiness', 'nero.egress']) {
    const options = await policy.beforeCreate({ Image: 'image', User: '10001:10001', Labels: { [label]: '1' },
      HostConfig: { Memory: 128 * 1024 * 1024 } });
    assert.equal(options.HostConfig?.CgroupParent, WORKLOAD_SLICE);
    assert.equal(options.Labels?.['nero.runtime.invocation'], env.INVOCATION_ID);
    const inspect: any = { Id: 'id', Config: { Labels: options.Labels }, HostConfig: options.HostConfig };
    await policy.beforeUse(inspect);
    inspect.Config.Labels['nero.runtime.invocation'] = 'old';
    await assert.rejects(policy.beforeUse(inspect), /stale|invocation|策略/);
  }
  snapshot.available = 100 * 1024 * 1024;
  await assert.rejects(policy.beforeCreate({ Image: 'image', User: '10001:10001', Labels: { 'nero.skill-readiness': '1' }, HostConfig: { Memory: 384 * 1024 * 1024 } }), /memory|内存/);
});

test('independent watchdog reaps only owned stale workloads, preserves live invocation and database, trips on sampler failure', () => {
  const code = `import importlib.util,sys,tempfile,pathlib
spec=importlib.util.spec_from_file_location('guard','scripts/ops/runtime-guard.py')
g=importlib.util.module_from_spec(spec);spec.loader.exec_module(g)
def item(kind,inv='current'):
 return {'Id':kind,'Config':{'Labels':{kind:'1','nero.runtime.invocation':inv,'nero.runtime.managed':'1'}},'HostConfig':{'CgroupParent':g.WORKLOAD_SLICE}}
items=[item('nero.sandbox','old'),item('nero.skill-run'),item('nero.skill-readiness'),item('nero.egress'),{'Id':'database','Config':{'Labels':{'com.docker.compose.service':'postgres'}}}]
assert [x['Id'] for x in g.reap_candidates(items,True,'current')]==['nero.sandbox']
assert len(g.reap_candidates(items,False,'current'))==4
with tempfile.TemporaryDirectory() as d:
 root=pathlib.Path(d); paths=g.Paths(root/'cgroup',root/'run',root/'missing-meminfo')
 paths.cgroup.mkdir()
 for name in [g.WORKLOAD_SLICE,g.APP_UNIT]:
  (paths.cgroup/name).mkdir();(paths.cgroup/name/'cgroup.kill').write_text('')
 calls=[]
 def runner(args,**kwargs):
  calls.append(args)
  if args[:2]==['systemctl','stop']: return ''
  if args[:2]==['docker','ps']: return ''
  raise RuntimeError('sampler failed')
 guard=g.Guard(paths,runner)
 assert guard.tick()==False
 assert (paths.state/'tripped').exists()
 assert (paths.cgroup/g.WORKLOAD_SLICE/'cgroup.kill').read_text()=='1'
 assert (paths.cgroup/g.APP_UNIT/'cgroup.kill').read_text()=='1'
 assert ['systemctl','stop',g.APP_UNIT] in calls
print('watchdog assertions passed')`;
  const result = spawnSync('python3', ['-c', code], { encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
  assert.equal(result.status, 0, result.stderr);
});

test('central Docker adapter applies policy to create/start and refuses exec of old containers', async () => {
  const { createDockerodeEngine } = await import('../src/mastra/sandbox/docker/client');
  const { createWorkloadPolicy, WORKLOAD_SLICE } = await import('../src/mastra/sandbox/workload-policy');
  const policy = createWorkloadPolicy({ NERO_RESOURCE_GUARD_ENABLED: 'true', INVOCATION_ID: 'b'.repeat(32) }, async () => ({
    available: 2 ** 30, runtimeCurrent: 0, runtimeMax: 960 * 2 ** 20, workloadsCurrent: 0, workloadsMax: 512 * 2 ** 20, tripped: false,
  }));
  const infos: any[] = []; let starts = 0;
  const docker: any = {
    async createContainer(options: any) { const id = String(infos.length); infos.push({ Id: id, HostConfig: options.HostConfig, Config: { Labels: options.Labels } }); return { id }; },
    getContainer(id: string) { return { inspect: async () => infos[Number(id)], start: async () => { starts++; }, exec: async () => { throw new Error('must not execute stale container'); } }; },
  };
  const engine = await createDockerodeEngine(docker, policy);
  for (const kind of ['nero.sandbox', 'nero.skill-run', 'nero.skill-readiness', 'nero.egress']) {
    const { id } = await engine.create({ Image: 'image', User: '10001:10001', Labels: { [kind]: '1' }, HostConfig: { Memory: 128 * 2 ** 20 } });
    assert.equal(infos[Number(id)].HostConfig.CgroupParent, WORKLOAD_SLICE);
    await engine.start(id);
  }
  assert.equal(starts, 4);
  infos[0].Config.Labels['nero.runtime.invocation'] = 'old';
  await assert.rejects(engine.exec('0', 'bash', [], { cwd: '/workspace', timeoutMs: 1000 }), /stale/);
  await assert.rejects(engine.start('0'), /stale/);
});

test('workload admission rejects exhausted aggregate budgets, tripped guard, unlimited cgroup and missing owner', async () => {
  const { createWorkloadPolicy } = await import('../src/mastra/sandbox/workload-policy');
  const budget = { available: 2 ** 30, runtimeCurrent: 0, runtimeMax: 960 * 2 ** 20, workloadsCurrent: 0, workloadsMax: 512 * 2 ** 20, tripped: false };
  const policy = createWorkloadPolicy({ NERO_RESOURCE_GUARD_ENABLED: 'true', INVOCATION_ID: 'c'.repeat(32) }, async () => budget);
  const options: any = { Image: 'image', User: '10001:10001', Labels: { 'nero.skill-run': '1' }, HostConfig: { Memory: 384 * 2 ** 20 } };
  budget.workloadsCurrent = 200 * 2 ** 20;
  await assert.rejects(policy.beforeCreate(options), /memory/);
  budget.workloadsCurrent = 0; budget.tripped = true;
  await assert.rejects(policy.beforeCreate(options), /tripped/);
  budget.tripped = false; budget.workloadsMax = Infinity;
  await assert.rejects(policy.beforeCreate(options), /unbounded/);
  const missing = createWorkloadPolicy({ NERO_RESOURCE_GUARD_ENABLED: 'true' }, async () => budget);
  await assert.rejects(missing.beforeCreate(options), /invocation/);
});

test('guard preflight verifies actual limits and database budget before reclaiming old containers', () => {
  const code = `import importlib.util,tempfile,pathlib,json
spec=importlib.util.spec_from_file_location('guard','scripts/ops/runtime-guard.py');g=importlib.util.module_from_spec(spec);spec.loader.exec_module(g)
with tempfile.TemporaryDirectory() as d:
 root=pathlib.Path(d);paths=g.Paths(root/'cgroup',root/'state',root/'meminfo',root/'proc'); paths.cgroup.mkdir();(paths.cgroup/g.WORKLOAD_SLICE).mkdir()
 (paths.proc/'42').mkdir(parents=True);(paths.proc/'42'/'cgroup').write_text('0::/system.slice/docker-postgres.scope')
 for group,limit in [(paths.cgroup,960*g.MIB),(paths.cgroup/g.WORKLOAD_SLICE,512*g.MIB)]:
  (group/'memory.max').write_text(str(limit));(group/'memory.swap.max').write_text('0')
 (paths.cgroup/'memory.events').write_text('oom_kill 0'); paths.meminfo.write_text('MemAvailable: 1000000 kB')
 pg={'State':{'Running':True,'Pid':42},'HostConfig':{'Memory':384*g.MIB,'MemorySwap':384*g.MIB}}
 calls=[];inv='a'*32
 def run(args,**kwargs):
  calls.append(args)
  if args[:3]==['systemctl','show',g.APP_UNIT]:
   if 'Slice' in args:return 'nero-runtime.slice'
   return 'ActiveState=activating'+chr(10)+'MainPID=0'+chr(10)+'InvocationID='+inv+chr(10)+'Result=success'
  if args[:2]==['systemctl','is-active']:return ''
  if args[:2]==['docker','info']:return 'systemd:2'
  if args[:3]==['docker','inspect','nero-agent-postgres']:return json.dumps([pg])
  if args[:2]==['docker','ps']:return ''
  raise AssertionError(args)
 guard=g.Guard(paths,run,{'NERO_RESOURCE_GUARD_ENABLED':'true','INVOCATION_ID':inv});guard.preflight()
 pg['HostConfig']['Memory']=0
 try:guard.preflight();raise AssertionError('accepted unlimited database')
 except RuntimeError as e:assert 'PostgreSQL' in str(e)
 pg['HostConfig']['Memory']=384*g.MIB;pg['HostConfig']['CgroupParent']='nero-runtime.slice'
 try:guard.preflight();raise AssertionError('accepted database inside kill group')
 except RuntimeError as e:assert 'outside' in str(e)
 (paths.cgroup/g.WORKLOAD_SLICE/'memory.max').write_text('max')
 try:guard.preflight();raise AssertionError('accepted unlimited shared group')
 except ValueError:pass
print('preflight assertions passed')`;
  const result = spawnSync('python3', ['-c', code], { encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
  assert.equal(result.status, 0, result.stderr);
});

test('monitor carries emergency intent when the normal stop command fails', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nero-emergency-'));
  try {
    await writeFile(join(dir, 'id'), '#!/bin/sh\necho 0\n', { mode: 0o755 });
    await writeFile(join(dir, 'systemctl'), `#!/bin/sh
case "$*" in *nero-runtime-emergency.service*) echo emergency >> "$STOP_RECORD"; exit 0;; esac
exit 1
`, { mode: 0o755 });
    const result = spawnSync('bash', ['scripts/ops/monitor.sh', '5'], { env: {
      ...process.env, PATH: dir + ':' + process.env.PATH, STOP_RECORD: join(dir, 'actions'),
    }, encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(await readFile(join(dir, 'actions'), 'utf8').catch(() => ''), /emergency/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('watchdog cumulative deadline trips even when individual Docker commands succeed slowly', () => {
  const code = `import importlib.util,tempfile,pathlib
spec=importlib.util.spec_from_file_location('guard','scripts/ops/runtime-guard.py');g=importlib.util.module_from_spec(spec);spec.loader.exec_module(g)
with tempfile.TemporaryDirectory() as d:
 root=pathlib.Path(d);paths=g.Paths(root/'cgroup',root/'state',root/'meminfo'); paths.cgroup.mkdir()
 for name in [g.APP_UNIT,g.WORKLOAD_SLICE]:
  (paths.cgroup/name).mkdir();(paths.cgroup/name/'cgroup.kill').write_text('')
 clock=[0];calls=[]
 def runner(args,**kwargs):
  calls.append(args)
  if args[:2]==['systemctl','show']:return 'ActiveState=active'+chr(10)+'MainPID=42'+chr(10)+'InvocationID='+('d'*32)+chr(10)+'Result=success'
  if args[:2]==['docker','ps']:clock[0]+=11;return ''
  return ''
 guard=g.Guard(paths,runner,clock=lambda:clock[0]);guard.sample=lambda:(1000*g.MIB,0)
 assert guard.tick()==False
 assert (paths.state/'tripped').exists()
 assert (paths.cgroup/g.WORKLOAD_SLICE/'cgroup.kill').read_text()=='1'
 assert ['systemctl','stop',g.APP_UNIT] in calls
print('cumulative deadline assertion passed')`;
  const result = spawnSync('python3', ['-c', code], { encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
  assert.equal(result.status, 0, result.stderr);
});
