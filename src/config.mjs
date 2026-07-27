import fs from 'node:fs';
import path from 'node:path';

/**
 * Guard enforcement modes.
 *  - 'enforce'  : Layer 1 AND Layer 2 matches block the prompt.
 *  - 'advisory' : Layer 1 still blocks (real identifiers are never allowed);
 *                 Layer 2 only warns (injected as context) and lets it through.
 */
export const MODES = ['enforce', 'advisory'];
export const DEFAULT_MODE = 'advisory';
export const CONFIG_FILENAME = '.inverita-guard.json';

function normalizeMode(mode) {
  return typeof mode === 'string' && MODES.includes(mode.toLowerCase()) ? mode.toLowerCase() : null;
}

/**
 * Walk up from `cwd` looking for the nearest `.inverita-guard.json` that
 * declares a mode. `{ "mode": "enforce" | "advisory" }` wins; a bare
 * `{ "healthcare": true }` marker means 'enforce'. Configs with neither
 * directive (or unreadable/invalid) are skipped so they can't shadow a parent's
 * real config. Returns the mode string or null when none is found.
 */
export function readProjectMode(cwd) {
  if (typeof cwd !== 'string' || !cwd) return null;
  let dir = path.resolve(cwd);
  for (;;) {
    try {
      const cfg = JSON.parse(fs.readFileSync(path.join(dir, CONFIG_FILENAME), 'utf8'));
      const m = normalizeMode(cfg.mode);
      if (m) return m;
      if (cfg.healthcare === true) return 'enforce';
      /* config present but no directive — keep walking up */
    } catch {
      /* no/invalid config here — keep walking up */
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null; // reached filesystem root
    dir = parent;
  }
}

/**
 * Resolve the effective mode. Precedence (highest first):
 *   1. INVERITA_GUARD_MODE env var  (org can pin 'enforce' via managed settings)
 *   2. nearest .inverita-guard.json in the project tree
 *   3. DEFAULT_MODE ('advisory')
 */
export function resolveMode({ cwd, env } = {}) {
  const envMode = normalizeMode(env?.INVERITA_GUARD_MODE);
  if (envMode) return envMode;
  const projectMode = readProjectMode(cwd);
  if (projectMode) return projectMode;
  return DEFAULT_MODE;
}
