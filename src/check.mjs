import { detect, decideAction } from '../hooks/pre-prompt-guard.mjs';
import { UNKNOWN } from './environment.mjs';

/**
 * Evaluate a prompt against the detector and resolve the action for a mode and
 * environment. Returns { action: 'block' | 'warn' | 'excepted' | 'clean',
 * tier, category, mode, environment }.
 * Defaults to 'enforce' + UNKNOWN so a bare runCheck() reports the strict
 * verdict with no environment influence.
 * `exceptions` is a Set of Layer-2 category ids (see src/config.mjs
 * resolveExceptionCategories) — a Layer-1 hit is never affected by it.
 */
export function runCheck(prompt, mode = 'enforce', exceptions = new Set(), environment = UNKNOWN) {
  const hit = detect(prompt);
  if (!hit) return { action: 'clean', tier: null, category: null, mode, environment };
  if (hit.tier === 2 && exceptions.has(hit.category)) {
    return { action: 'excepted', tier: hit.tier, category: hit.category, mode, environment };
  }
  return {
    action: decideAction(hit, mode, environment),
    tier: hit.tier,
    category: hit.category,
    mode,
    environment,
  };
}
