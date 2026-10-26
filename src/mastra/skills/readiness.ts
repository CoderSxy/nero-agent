import { pickInterpreter } from './runtime-interpreter';
import { createHash } from 'node:crypto';
import type { SkillRuntimeManifest } from './types';

export type ReadinessItem = {
  kind: 'platform' | 'runtime' | 'python' | 'node' | 'command' | 'tool' | 'network';
  name: string;
  status: 'ok' | 'missing' | 'mismatch';
  message: string;
  actual?: string;
  required?: string;
};
export type ReadinessReport = {
  status: 'ready' | 'instructions-only' | 'blocked' | 'needs-declaration' | 'failed';
  fingerprint: string;
  checkedAt: string;
  expiresAt: string;
  items: ReadinessItem[];
  message: string;
};
export type ReadinessInput = {
  skillMd: string;
  files: Array<{ path: string; hash: string }>;
  runtime: SkillRuntimeManifest | null;
  toolIds: string[];
};
export type ReadinessChecker = ReturnType<typeof createReadinessChecker>;
export function canPublishReadiness(report: ReadinessReport): boolean {
  return report.status === 'ready' || report.status === 'instructions-only';
}
export function createReadinessChecker(deps: {
  environment: () => { fingerprint: string; enabled: boolean; scriptEnabled: boolean; publicNetwork: boolean };
  probe: (runtime: SkillRuntimeManifest) => Promise<ReadinessItem[]>;
  now?: () => number;
}) {
  const cache = new Map<string, ReadinessReport>();
  const inflight = new Map<string, Promise<ReadinessReport>>();
  const now = deps.now ?? Date.now;
  return {
    async check(input: ReadinessInput, force = false): Promise<ReadinessReport> {
      const environment = deps.environment();
      const fingerprint = createHash('sha256').update(JSON.stringify({ checker: 1, environment, ...input, toolIds: [...input.toolIds].sort(), files: [...input.files].sort((a, b) => a.path.localeCompare(b.path)) })).digest('hex');
      const cached = cache.get(fingerprint);
      if (!force && cached && Date.parse(cached.expiresAt) > now()) return cached;
      const pending = inflight.get(fingerprint); if (pending) return pending;
      if (inflight.size >= 20) throw new Error('运行检查繁忙，请稍后重试');
      const run = async (): Promise<ReadinessReport> => {
        const checkedAt = new Date(now()).toISOString();
        const items: ReadinessItem[] = [];
        const finish = (status: ReadinessReport['status'], message: string): ReadinessReport => {
          const report = { status, fingerprint, checkedAt, expiresAt: new Date(now() + (status === 'failed' ? 5000 : 300000)).toISOString(), items, message };
          if (cache.size >= 100) cache.delete(cache.keys().next().value!);
          cache.set(fingerprint, report); return report;
        };
        const scriptFiles = input.files.some(file => /\.(?:py|[cm]?js|ts|sh|bash)$/i.test(file.path));
        const runtime = input.runtime;
        for (const tool of runtime?.requiredTools ?? []) if (!input.toolIds.includes(tool)) items.push({ kind: 'tool', name: tool, status: 'missing', message: `当前账号缺少工具 ${tool}，其他用户仍需独立授权` });
        if (runtime?.network === 'public' && !environment.publicNetwork) items.push({ kind: 'network', name: 'public', status: 'missing', message: '当前环境未开启公网访问' });
        if (items.length) return finish('blocked', '存在未满足的运行条件');
        if ((!runtime || !runtime.entrypoints.length) && scriptFiles) return finish('needs-declaration', '包内包含脚本，请补充 skill-runtime.json v2 的入口和依赖声明');
        if (runtime && !runtime.entrypoints.length && (runtime.runtimes.length || Object.values(runtime.dependencies ?? {}).some(list => list.length))) return finish('needs-declaration', '已声明执行依赖，请补充脚本入口');
        if (!runtime || !runtime.entrypoints.length) return finish('instructions-only', '仅提供指令和参考资料，不要求脚本运行环境');
        if (runtime.schemaVersion !== 2) return finish('needs-declaration', '请升级为 skill-runtime.json v2，明确声明运行依赖（无依赖可填写空对象）');
        for (const entry of runtime.entrypoints) if (!input.files.some(file => file.path === entry)) items.push({ kind: 'platform', name: entry, status: 'missing', message: `缺少入口文件 ${entry}` });
        if (!environment.enabled || !environment.scriptEnabled) items.push({ kind: 'platform', name: 'script-execution', status: 'missing', message: '平台技能或沙箱脚本执行能力未开启，请联系管理员检查配置' });
        for (const entry of runtime.entrypoints) if (!pickInterpreter(entry, runtime)) items.push({ kind: 'runtime', name: entry, status: 'mismatch', message: `入口 ${entry} 的文件类型不支持，或未声明匹配的解释器` });
        if (!runtime.runtimes.length) items.push({ kind: 'runtime', name: 'interpreter', status: 'missing', message: '未声明脚本解释器' });
        if (items.length) return finish('blocked', '存在未满足的运行条件');
        try {
          items.push(...await deps.probe(runtime));
          if (JSON.stringify(deps.environment()) !== JSON.stringify(environment)) return finish('failed', '运行配置在检查期间发生变化，请重新检查');
          return items.some(item => item.status !== 'ok') ? finish('blocked', '存在缺失依赖或版本不符，请修复后重新检查') : finish('ready', '已通过声明的运行环境检查，实际产物仍取决于脚本和输入');
        } catch {
          return finish('failed', '沙箱环境检查失败，请检查 Docker 服务、镜像和临时目录权限后重试');
        }
      };
      const promise = run(); inflight.set(fingerprint, promise);
      try { return await promise; } finally { inflight.delete(fingerprint); }
    },
  };
}
