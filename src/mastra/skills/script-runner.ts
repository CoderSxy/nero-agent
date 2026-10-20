import { readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { ThreadLookup } from '../auth/thread-guard';
import { assertThreadOwned } from '../auth/thread-guard';
import type { DockerEngine } from '../sandbox/docker/client';
import { ExecutionQueue, commandQueue } from '../sandbox/execution-queue';
import { assertHostQuotaReady } from '../workspace/disk-protection';
import { ensureThreadDirectory, ensureUserWorkspace } from '../workspace/manager';
import { isSkillScriptExecutionEnabled } from './config';
import {
  createSkillScriptContainerOptions,
  validateSkillScriptContainerOptions,
  SKILL_SCRIPT_RUN_LABEL,
} from './script-container';
import type {
  SkillExecutionContext,
  SkillPin,
  SkillResult,
  SkillRuntimeManifest,
  SkillScriptOutput,
} from './types';
import { normalizeSkillPath } from './validation';

const MAX_ARGS = 64;
const MAX_ARG_CHARS = 4096;
const MAX_ARGS_TOTAL_BYTES = 16 * 1024;
const OUTPUT_TRUNCATE_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 120_000;
const SHELL_META_RE = /[;&|`$<>\\\n\r]/

const INTERPRETERS = {
  python3: 'python3',
  node: 'node',
  bash: 'bash',
} as const;

type Check<T> = { ok: true; data: T } | { ok: false; code: string; message: string };

export type SkillScriptExecuteInput = {
  skillName: string;
  path: string;
  args?: string[];
};

export type SkillScriptResolveData = {
  pin: SkillPin;
  /** Absolute host path — INTERNAL ONLY. */
  releaseRoot: string;
  runtimeManifest: SkillRuntimeManifest | null;
};

export type SkillScriptRunnerDeps = {
  engine: DockerEngine;
  lookup: ThreadLookup;
  /** Load/pin + resolve verified release; must re-check use permission. */
  resolve: (
    ctx: SkillExecutionContext,
    skillName: string,
  ) => Promise<SkillResult<SkillScriptResolveData>>;
  imageDigest: string;
  queue?: ExecutionQueue;
  timeoutMs?: number;
  /** After destroy failures, retry this many extra times (default 2 → 3 attempts). */
  removeRetries?: number;
};

export type SkillScriptRunner = {
  execute: (
    ctx: SkillExecutionContext,
    input: SkillScriptExecuteInput,
    signal?: AbortSignal,
  ) => Promise<SkillResult<SkillScriptOutput>>;
};

function fail(code: string, message: string): SkillResult<never> {
  return { ok: false, code, message };
}

function truncate(text: string): { text: string; truncated: boolean } {
  const buf = Buffer.from(text, 'utf8');
  if (buf.byteLength <= OUTPUT_TRUNCATE_BYTES) return { text, truncated: false };
  return {
    text: buf.subarray(0, OUTPUT_TRUNCATE_BYTES).toString('utf8'),
    truncated: true,
  };
}

function validateArgs(args: string[] | undefined): Check<string[]> {
  const list = args ?? [];
  if (list.length > MAX_ARGS) {
    return { ok: false, code: 'SCRIPT_NOT_ALLOWED', message: `At most ${MAX_ARGS} args are allowed` };
  }
  let total = 0;
  for (const arg of list) {
    if (typeof arg !== 'string') {
      return { ok: false, code: 'SCRIPT_NOT_ALLOWED', message: 'Args must be strings' };
    }
    if (arg.length > MAX_ARG_CHARS) {
      return {
        ok: false,
        code: 'SCRIPT_NOT_ALLOWED',
        message: `Each arg must be ≤ ${MAX_ARG_CHARS} characters`,
      };
    }
    if (SHELL_META_RE.test(arg)) {
      return {
        ok: false,
        code: 'SCRIPT_NOT_ALLOWED',
        message: 'Args must not contain shell metacharacters',
      };
    }
    total += Buffer.byteLength(arg, 'utf8');
    if (total > MAX_ARGS_TOTAL_BYTES) {
      return {
        ok: false,
        code: 'SCRIPT_NOT_ALLOWED',
        message: `Args total size must be ≤ ${MAX_ARGS_TOTAL_BYTES} bytes`,
      };
    }
  }
  return { ok: true, data: list };
}

function pickInterpreter(
  scriptPath: string,
  runtime: SkillRuntimeManifest | null,
): string | null {
  const allowed = new Set(runtime?.runtimes ?? ['python3', 'node', 'bash']);
  const lower = scriptPath.toLowerCase();
  let choice: keyof typeof INTERPRETERS | null = null;
  if (lower.endsWith('.py')) choice = 'python3';
  else if (lower.endsWith('.js') || lower.endsWith('.mjs') || lower.endsWith('.cjs')) choice = 'node';
  else if (lower.endsWith('.sh')) choice = 'bash';
  if (!choice || !allowed.has(choice)) return null;
  return INTERPRETERS[choice];
}

function validateScriptPath(
  rawPath: string,
  runtime: SkillRuntimeManifest | null,
): Check<string> {
  if (typeof rawPath !== 'string' || !rawPath) {
    return { ok: false, code: 'SCRIPT_NOT_ALLOWED', message: 'Script path is required' };
  }
  if (rawPath.startsWith('/') || /^[A-Za-z]:/.test(rawPath) || rawPath.includes('\\') || rawPath.includes('\0')) {
    return {
      ok: false,
      code: 'SCRIPT_NOT_ALLOWED',
      message: 'Absolute or unsafe script paths are not allowed',
    };
  }
  let normalized: string;
  try {
    normalized = normalizeSkillPath(rawPath);
  } catch {
    return { ok: false, code: 'SCRIPT_NOT_ALLOWED', message: 'Invalid script path' };
  }
  if (!normalized.startsWith('scripts/')) {
    return { ok: false, code: 'SCRIPT_NOT_ALLOWED', message: 'Script path must be under scripts/' };
  }
  const entrypoints = runtime?.entrypoints ?? [];
  if (!entrypoints.includes(normalized)) {
    return {
      ok: false,
      code: 'SCRIPT_NOT_ALLOWED',
      message: 'Script path is not an allowed entrypoint',
    };
  }
  return { ok: true, data: normalized };
}

async function destroyWithRetry(
  engine: DockerEngine,
  containerId: string,
  retries: number,
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      await engine.remove(containerId, true);
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Failed to destroy skill script container');
}

async function listThreadRelativeArtifacts(threadHostPath: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(abs);
      } else if (entry.isFile()) {
        out.push(relative(threadHostPath, abs).replace(/\\/g, '/'));
      }
    }
  }
  await walk(threadHostPath);
  return out.sort();
}

export function createSkillScriptRunner(deps: SkillScriptRunnerDeps): SkillScriptRunner {
  const queue = deps.queue ?? commandQueue;
  const removeRetries = deps.removeRetries ?? 2;
  const timeoutMs = Math.min(
    Math.max(1, deps.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    MAX_TIMEOUT_MS,
  );

  return {
    async execute(ctx, input, signal) {
      if (!isSkillScriptExecutionEnabled()) {
        return fail('RUNTIME_UNAVAILABLE', 'Skill script execution is unavailable');
      }
      if (signal?.aborted) {
        return fail('ABORTED', 'Skill script execution was cancelled');
      }
      if (!ctx.threadId) {
        return fail('RUNTIME_UNAVAILABLE', 'threadId is required');
      }

      try {
        assertHostQuotaReady();
      } catch {
        return fail('RUNTIME_UNAVAILABLE', 'Sandbox quota or write gate is not ready');
      }

      const resolved = await deps.resolve(ctx, input.skillName);
      if (!resolved.ok) return resolved;

      const { pin, releaseRoot, runtimeManifest } = resolved.data;
      const pathCheck = validateScriptPath(input.path, runtimeManifest);
      if (!pathCheck.ok) return fail(pathCheck.code, pathCheck.message);
      const scriptPath = pathCheck.data;

      const argsCheck = validateArgs(input.args);
      if (!argsCheck.ok) return fail(argsCheck.code, argsCheck.message);
      const args = argsCheck.data;

      const interpreter = pickInterpreter(scriptPath, runtimeManifest);
      if (!interpreter) {
        return fail('DEPENDENCY_MISSING', 'No allowed interpreter for this script');
      }

      try {
        await assertThreadOwned(ctx.auth, ctx.threadId, deps.lookup);
      } catch {
        return fail('FORBIDDEN', 'Thread is not owned by the caller');
      }

      const { hostPath: threadHostPath, containerPath } = await ensureThreadDirectory(
        ctx.auth,
        ctx.threadId,
        deps.lookup,
      );
      const workspaceRoot = await ensureUserWorkspace(ctx.auth);

      // Snapshot files before run so we can report new relative artifacts only.
      const before = new Set(await listThreadRelativeArtifacts(threadHostPath));

      try {
        return await queue.run(
          ctx.auth.userId,
          ctx.threadId,
          async () => {
            if (signal?.aborted) {
              return fail('ABORTED', 'Skill script execution was cancelled');
            }

            const options = createSkillScriptContainerOptions({
              workspaceRoot,
              releaseRoot,
              labels: {
                [`${SKILL_SCRIPT_RUN_LABEL}.user`]: ctx.auth.userId,
                [`${SKILL_SCRIPT_RUN_LABEL}.skill`]: pin.skillId,
              },
              imageDigest: deps.imageDigest,
            });
            validateSkillScriptContainerOptions(options, { workspaceRoot, releaseRoot });

            let containerId: string | undefined;
            try {
              const created = await deps.engine.create(options);
              containerId = created.id;
              await deps.engine.start(containerId);

              const containerScript = `/skill/${scriptPath}`;
              // Argv form only — never compose a shell command string.
              const result = await deps.engine.exec(
                containerId,
                interpreter,
                [containerScript, ...args],
                {
                  cwd: containerPath,
                  timeoutMs,
                  abortSignal: signal,
                },
              );

              const stdout = truncate(result.stdout ?? '');
              const stderr = truncate(result.stderr ?? '');
              const after = await listThreadRelativeArtifacts(threadHostPath);
              const artifactRelativePaths = after.filter((p) => !before.has(p));

              return {
                ok: true as const,
                skill: pin,
                data: {
                  exitCode: result.exitCode,
                  stdout: stdout.text,
                  stderr: stderr.text,
                  truncated: stdout.truncated || stderr.truncated,
                  timedOut: Boolean(result.timedOut),
                  artifactRelativePaths,
                } satisfies SkillScriptOutput,
              };
            } catch (error) {
              if (signal?.aborted || (error instanceof Error && /abort|cancel/i.test(error.message))) {
                return fail('ABORTED', 'Skill script execution was cancelled');
              }
              if (error instanceof Error && /timed out/i.test(error.message)) {
                return {
                  ok: true as const,
                  skill: pin,
                  data: {
                    exitCode: 124,
                    stdout: '',
                    stderr: '',
                    truncated: false,
                    timedOut: true,
                    artifactRelativePaths: [],
                  } satisfies SkillScriptOutput,
                };
              }
              return fail(
                'EXECUTION_FAILED',
                error instanceof Error ? error.message : 'Skill script execution failed',
              );
            } finally {
              if (containerId) {
                try {
                  await destroyWithRetry(deps.engine, containerId, removeRetries);
                } catch {
                  // Orphan cleaner reclaims nero.skill-run=1 containers.
                }
              }
            }
          },
          signal,
        );
      } catch (error) {
        if (signal?.aborted || (error instanceof Error && /cancel|abort/i.test(error.message))) {
          return fail('ABORTED', 'Skill script execution was cancelled');
        }
        return fail(
          'EXECUTION_FAILED',
          error instanceof Error ? error.message : 'Skill script execution failed',
        );
      }
    },
  };
}

/** Re-export limit constants used by tools/validation. */
export const SKILL_SCRIPT_LIMITS = {
  MAX_ARGS,
  MAX_ARG_CHARS,
  MAX_ARGS_TOTAL_BYTES,
  OUTPUT_TRUNCATE_BYTES,
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
} as const;
