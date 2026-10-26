import Docker from 'dockerode';
import { createHash } from 'node:crypto';
import { createReadinessChecker } from './readiness';
import { createDockerReadinessProbe } from './readiness-probe';
import { createDockerodeEngine } from '../sandbox/docker/client';
import { isAgentSkillsEnabled, isSkillScriptExecutionEnabled, skillScriptImageDigest } from './config';
import { getSandboxRuntimeConfig } from '../sandbox/runtime-config';
let engine: ReturnType<typeof createDockerodeEngine> | undefined;
export const defaultReadinessChecker = createReadinessChecker({
  environment: () => {
    const settings = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(SANDBOX_|SKILL_|AGENT_SKILLS_|WORKSPACE_)/.test(key)).sort(([a], [b]) => a.localeCompare(b)));
    let publicNetwork = false;
    try { publicNetwork = getSandboxRuntimeConfig().networkMode === 'public-http'; } catch { /* Invalid settings remain unavailable. */ }
    return { fingerprint: createHash('sha256').update(JSON.stringify(settings)).digest('hex'), enabled: isAgentSkillsEnabled(), scriptEnabled: isSkillScriptExecutionEnabled(), publicNetwork };
  },
  probe: createDockerReadinessProbe({ engine: async () => { engine ??= createDockerodeEngine(new Docker({ timeout: 15000 })); try { return await engine; } catch (error) { engine = undefined; throw error; } }, image: skillScriptImageDigest,
    dependenciesEnabled: () => getSandboxRuntimeConfig().dependenciesEnabled,
    advancedRuntime: runtime => { const config = getSandboxRuntimeConfig(); return config.dependenciesEnabled || (runtime.network === 'public' && config.networkMode === 'public-http'); },
  }),
});
