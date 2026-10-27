#!/usr/bin/env python3
"""Independent, fail-closed resource guard. No app imports and no database credentials."""
import argparse
import fcntl
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import time

APP_UNIT = 'nero-agent.service'
WORKLOAD_SLICE = 'nero-runtime-workloads.slice'
KINDS = ('nero.sandbox', 'nero.skill-run', 'nero.skill-readiness', 'nero.egress')
MIB = 1024 * 1024

class Paths:
    def __init__(self, cgroup=Path('/sys/fs/cgroup/nero.slice/nero-runtime.slice'),
                 state=Path('/run/nero-resource-guard'), meminfo=Path('/proc/meminfo'), proc=Path('/proc')):
        self.cgroup, self.state, self.meminfo = Path(cgroup), Path(state), Path(meminfo)
        self.proc = Path(proc)


def command(args, timeout=5):
    result = subprocess.run(args, check=True, capture_output=True, text=True, timeout=timeout)
    return result.stdout.strip()


def owned(info):
    labels = info.get('Config', {}).get('Labels') or {}
    return any(labels.get(kind) == '1' for kind in KINDS)


def reap_candidates(containers, live, invocation):
    result = []
    for info in containers:
        if not owned(info):
            continue
        labels = info.get('Config', {}).get('Labels') or {}
        if not live or labels.get('nero.runtime.invocation') != invocation or labels.get('nero.runtime.managed') != '1' \
                or info.get('HostConfig', {}).get('CgroupParent') != WORKLOAD_SLICE:
            result.append(info)
    return result


class Guard:
    def __init__(self, paths=None, runner=command, environment=None, clock=time.monotonic):
        self.paths, self.runner = paths or Paths(), runner
        self.clock = clock
        self.deadline = clock() + 20
        self.environment = os.environ if environment is None else environment

    def run(self, args, timeout=5):
        remaining = self.deadline - self.clock()
        if remaining <= 0:
            raise TimeoutError('Resource guard overall deadline exceeded')
        result = self.runner(args, timeout=min(timeout, remaining))
        if self.clock() > self.deadline:
            raise TimeoutError('Resource guard overall deadline exceeded')
        return result

    def status(self):
        output = self.run(['systemctl', 'show', APP_UNIT, '-p', 'ActiveState', '-p', 'MainPID', '-p', 'InvocationID', '-p', 'Result'])
        props = dict(line.split('=', 1) for line in output.splitlines() if '=' in line)
        if not {'ActiveState', 'MainPID', 'InvocationID', 'Result'} <= props.keys():
            raise RuntimeError('Incomplete service status')
        if not props['MainPID'].isdigit():
            raise RuntimeError('Invalid service PID')
        return props

    def sample(self):
        available = re.search(r'^MemAvailable:\s+(\d+) kB$', self.paths.meminfo.read_text(), re.M)
        if not available:
            raise RuntimeError('Host memory unavailable')
        root = self.paths.cgroup
        child = root / WORKLOAD_SLICE
        for group, cap in ((root, 960 * MIB), (child, 512 * MIB)):
            limit = int((group / 'memory.max').read_text())
            if limit <= 0 or limit > cap or int((group / 'memory.swap.max').read_text()) != 0:
                raise RuntimeError('Shared cgroup limits missing or unbounded')
        events = dict(line.split() for line in (root / 'memory.events').read_text().splitlines())
        return int(available[1]) * 1024, int(events['oom_kill'])

    def containers(self):
        ids = set()
        for kind in KINDS:
            ids.update(self.run(['docker', 'ps', '-aq', '--no-trunc', '--filter', 'label=' + kind + '=1']).split())
        if len(ids) > 128 or any(not re.fullmatch(r'[a-f0-9]{12,64}', ident) for ident in ids):
            raise RuntimeError('Unexpected workload container inventory')
        result = []
        for ident in sorted(ids):
            try:
                result.extend(json.loads(self.run(['docker', 'inspect', ident])))
            except subprocess.CalledProcessError:
                # A normally completed task can disappear between list and inspect.
                # Re-list; only absence is accepted, daemon errors remain failures.
                current = self.run(['docker', 'ps', '-aq', '--no-trunc', '--filter', 'id=' + ident])
                if current:
                    raise
        return result

    def remove(self, containers):
        for info in containers:
            if owned(info):
                self.run(['docker', 'rm', '-f', info['Id']])  # Never --volumes, never workspace deletion.

    def trip(self, reason):
        self.paths.state.mkdir(mode=0o755, parents=True, exist_ok=True)
        (self.paths.state / 'tripped').write_text(reason + '\n')
        print('Resource guard tripped: ' + reason, file=sys.stderr)

    def emergency(self, reason):
        # Give emergency cleanup its own bounded window after the sampling deadline.
        self.deadline = self.clock() + 12
        # Persist admission denial before attempting service or Docker operations.
        ok = True
        try:
            self.trip(reason)
        except OSError:
            ok = False
            print('Cannot persist admission trip marker; terminating workload cgroup anyway', file=sys.stderr)
        # Kill only the dedicated task slice and app unit, never the entire parent slice.
        for group in (self.paths.cgroup / WORKLOAD_SLICE, self.paths.cgroup / APP_UNIT):
            try:
                (group / 'cgroup.kill').write_text('1')
            except OSError:
                ok = False  # Docker cleanup and systemctl stop are independent fallbacks.
        try:
            self.run(['systemctl', 'stop', APP_UNIT], timeout=10)
        except Exception:
            ok = False
        try:
            self.remove(self.containers())
        except Exception:
            ok = False
            print('Workload cleanup failed; cgroup termination attempted; guard must be retried', file=sys.stderr)
        return ok

    def preflight(self):
        props = self.status()
        if props['ActiveState'] != 'activating' or props['MainPID'] != '0':
            raise RuntimeError('Preflight is allowed only inside service ExecStartPre before the main process')
        if self.environment.get('NERO_RESOURCE_GUARD_ENABLED') != 'true' or self.environment.get('INVOCATION_ID') != props['InvocationID']:
            raise RuntimeError('Resource guard environment/invocation does not match systemd')
        if (self.paths.state / 'tripped').exists():
            raise RuntimeError('Resource guard is tripped; inspect failure and clear marker manually')
        if self.run(['docker', 'info', '--format', '{{.CgroupDriver}}:{{.CgroupVersion}}']) != 'systemd:2':
            raise RuntimeError('Docker requires systemd cgroup v2 driver')
        self.run(['systemctl', 'is-active', '--quiet', 'nero-runtime-guard.timer'])
        actual_slice = self.run(['systemctl', 'show', APP_UNIT, '-p', 'Slice', '--value'])
        if actual_slice != 'nero-runtime.slice':
            raise RuntimeError('Agent must belong to nero-runtime.slice')
        available, oom = self.sample()
        if available < 256 * MIB:
            raise RuntimeError('Insufficient host memory reserve')
        pg = json.loads(self.run(['docker', 'inspect', 'nero-agent-postgres']))[0]
        config = pg.get('HostConfig', {})
        memory = config.get('Memory', 0)
        if not isinstance(memory, int) or not 0 < memory <= 384 * MIB or config.get('MemorySwap') != memory:
            raise RuntimeError('PostgreSQL must have explicit memory <=384MiB and memory-swap equal to memory')
        if not pg.get('State', {}).get('Running') or 'nero-runtime' in config.get('CgroupParent', ''):
            raise RuntimeError('PostgreSQL must be running outside the task pool')
        pid = pg.get('State', {}).get('Pid', 0)
        if not isinstance(pid, int) or pid <= 0:
            raise RuntimeError('PostgreSQL process identity is unavailable')
        membership = (self.paths.proc / str(pid) / 'cgroup').read_text()
        unified = [line[3:] for line in membership.splitlines() if line.startswith('0::')]
        if len(unified) != 1 or unified[0] == '/nero.slice/nero-runtime.slice' or unified[0].startswith('/nero.slice/nero-runtime.slice/'):
            raise RuntimeError('PostgreSQL actual cgroup must stay outside the application kill groups')
        # Main process has not started yet. Recover old policy/invocation workloads first.
        self.remove(self.containers())
        self.paths.state.mkdir(mode=0o755, parents=True, exist_ok=True)
        (self.paths.state / 'oom-count').write_text(str(oom))

    def tick(self):
        try:
            props = self.status()
            available, oom = self.sample()
            previous = self.paths.state / 'oom-count'
            baseline = int(previous.read_text()) if previous.exists() else oom
            if available < 256 * MIB or oom > baseline or props['ActiveState'] == 'failed':
                self.emergency('low host memory, cgroup OOM or failed application')
                return False
            invocation = props['InvocationID']
            live = props['ActiveState'] in ('active', 'activating') and bool(re.fullmatch('[a-f0-9]{32}', invocation))
            if props['ActiveState'] == 'active' and props['MainPID'] == '0':
                raise RuntimeError('Active service has no main process')
            self.remove(reap_candidates(self.containers(), live, invocation))
            self.paths.state.mkdir(mode=0o755, parents=True, exist_ok=True)
            previous.write_text(str(oom))
            return True
        except Exception:
            self.emergency('resource sampling or workload reconciliation failed')
            return False


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--preflight', action='store_true')
    parser.add_argument('--emergency', action='store_true')
    args = parser.parse_args()
    if os.geteuid() != 0:
        raise SystemExit('Resource guard requires root')
    guard = Guard()
    def terminated(_signum, _frame):
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        signal.signal(signal.SIGINT, signal.SIG_IGN)
        if not args.preflight:
            guard.emergency('independent guard interrupted')
        raise SystemExit(1)
    signal.signal(signal.SIGTERM, terminated)
    signal.signal(signal.SIGINT, terminated)
    try:
        guard.paths.state.mkdir(mode=0o755, parents=True, exist_ok=True)
        lock_file = (guard.paths.state / 'lock').open('w')
    except OSError:
        if not args.preflight:
            guard.emergency('guard state storage unavailable')
        raise SystemExit(1)
    with lock_file as lock:
        # Startup may briefly overlap a healthy timer tick; wait with a bounded deadline.
        deadline = time.monotonic() + (10 if args.preflight else 0)
        while True:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if args.emergency:
                    guard.emergency('emergency requested during another guard run')
                    raise SystemExit(1)
                if not args.preflight:
                    return  # The in-flight independent guard owns this sweep.
                if time.monotonic() >= deadline:
                    raise SystemExit('Resource guard busy; retry startup later')
                time.sleep(0.1)
        guard.deadline = guard.clock() + 20
        try:
            if args.preflight:
                guard.preflight()
            elif args.emergency:
                guard.emergency('operator/monitor emergency stop')
                raise SystemExit(1)
            elif not guard.tick():
                raise SystemExit(1)
        except Exception as error:
            # Preflight is already inside the application unit: fail startup without killing itself.
            print('Resource guard failed: ' + type(error).__name__ + ': ' + str(error), file=sys.stderr)
            raise SystemExit(1)

if __name__ == '__main__':
    main()
