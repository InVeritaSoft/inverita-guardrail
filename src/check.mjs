import { detect } from '../hooks/pre-prompt-guard.mjs';

export function runCheck(prompt) {
  const hit = detect(prompt);
  if (!hit) return { decision: 'clean', tier: null, category: null };
  return { decision: 'block', tier: hit.tier, category: hit.category };
}
