import type { ReleaseStore } from './release-store';
import type { SkillRepository } from './repository';
import type { SkillService } from './service';
import type { SkillScriptResolveData } from './script-runner';
import type { SkillExecutionContext, SkillResult } from './types';

/**
 * Load/pin the skill first (even if not previously loaded), re-check use permission,
 * verify the pinned release, and return the internal release root + runtime manifest.
 */
export function createSkillScriptResolve(deps: {
  service: SkillService;
  repository: SkillRepository;
  releaseStore: ReleaseStore;
}): (
  ctx: SkillExecutionContext,
  skillName: string,
) => Promise<SkillResult<SkillScriptResolveData>> {
  return async (ctx, skillName) => {
    const loaded = await deps.service.load(ctx, skillName);
    if (!loaded.ok) return loaded;

    const pin = loaded.skill;
    const version = await deps.repository.getVersion(pin.skillId, pin.version);
    if (!version || version.state !== 'published' || !version.manifestHash) {
      return { ok: false, code: 'SKILL_UNAVAILABLE', message: 'Skill is unavailable' };
    }

    try {
      await deps.releaseStore.verifyRelease(pin.skillId, pin.version, pin.manifestHash);
      const releaseRoot = deps.releaseStore.resolveReleaseRoot(
        pin.skillId,
        pin.version,
        pin.manifestHash,
      );
      return {
        ok: true,
        skill: pin,
        data: {
          pin,
          releaseRoot,
          runtimeManifest: version.runtimeManifest,
        },
      };
    } catch {
      return { ok: false, code: 'RUNTIME_UNAVAILABLE', message: 'Skill release is unavailable' };
    }
  };
}
