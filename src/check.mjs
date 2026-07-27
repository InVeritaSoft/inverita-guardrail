import { detect, decideAction } from '../hooks/pre-prompt-guard.mjs';

/**
 * Evaluate a prompt against the detector and resolve the action for a mode.
 * Returns { action: 'block' | 'warn' | 'clean', tier, category, mode }.
 * Defaults to 'enforce' so a bare runCheck() reports the strict verdict.
 */
export function runCheck(prompt, mode = 'enforce') {
  const hit = detect(prompt);
  if (!hit) return { action: 'clean', tier: null, category: null, mode };
  return { action: decideAction(hit, mode), tier: hit.tier, category: hit.category, mode };
}
