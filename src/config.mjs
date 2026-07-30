import fs from 'node:fs';
import path from 'node:path';
import { LAYER1_CATEGORIES, LAYER2_CATEGORIES } from './categories.mjs';

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

/* ------------------------------------------------------------------ *
 * Project exceptions — Layer-2-only, reasoned false-positive allowlist
 * ------------------------------------------------------------------ *
 * Exceptions let a project allow a specific broad-net Layer-2 category
 * through (e.g. a pharmacy app that legitimately discusses dosages) without
 * touching detector source. They can NEVER reach Layer 1: every read path
 * below filters entries against LAYER2_CATEGORIES, so even a hand-edited
 * config naming a Layer-1 category (e.g. "ssn_pattern") is silently dropped.
 * This is a structural guarantee, not just a write-time validation — it holds
 * regardless of how the file was produced.
 */

/**
 * Walk up from `cwd` looking for the nearest `.inverita-guard.json` that
 * declares an `exceptions` array — same "skip if key absent" semantics as
 * readProjectMode. Returns a list of { category, reason }, filtered to valid
 * Layer-2 categories only.
 */
export function readProjectExceptions(cwd) {
  if (typeof cwd !== 'string' || !cwd) return [];
  let dir = path.resolve(cwd);
  for (;;) {
    try {
      const cfg = JSON.parse(fs.readFileSync(path.join(dir, CONFIG_FILENAME), 'utf8'));
      if (Array.isArray(cfg.exceptions)) {
        return cfg.exceptions
          .filter((e) => e && typeof e === 'object' && LAYER2_CATEGORIES.includes(e.category))
          .map((e) => ({ category: e.category, reason: typeof e.reason === 'string' ? e.reason : '' }));
      }
      /* config present but no `exceptions` key — keep walking up */
    } catch {
      /* no/invalid config here — keep walking up */
    }
    const parent = path.dirname(dir);
    if (parent === dir) return [];
    dir = parent;
  }
}

/** The effective set of excepted Layer-2 category ids for `cwd`. */
export function resolveExceptionCategories({ cwd } = {}) {
  return new Set(readProjectExceptions(cwd).map((e) => e.category));
}

function assertExceptableCategory(category) {
  if (LAYER1_CATEGORIES.includes(category)) {
    throw new Error(
      `"${category}" is a Layer-1 identifier check and can never be excepted — SSN/MRN/DOB/etc. ` +
        'are a hard safety floor. Only Layer-2 clinical-specificity categories can have project exceptions.',
    );
  }
  if (!LAYER2_CATEGORIES.includes(category)) {
    throw new Error(`Unknown category "${category}". Valid Layer-2 categories: ${LAYER2_CATEGORIES.join(', ')}`);
  }
}

function readExactConfig(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

/**
 * Add (or replace) a project exception in `<cwd>/.inverita-guard.json`,
 * creating the file if needed and preserving any other keys already there
 * (mode, healthcare, _comment*, other exceptions). Throws if `category` is a
 * Layer-1 identifier, unknown, or `reason` is empty — exceptions must stay
 * both safe (Layer-2 only) and auditable (reasoned).
 */
export function addProjectException(cwd, category, reason) {
  assertExceptableCategory(category);
  if (typeof reason !== 'string' || !reason.trim()) {
    throw new Error('A --reason is required so exceptions stay auditable.');
  }
  const dir = path.resolve(cwd);
  const file = path.join(dir, CONFIG_FILENAME);
  const cfg = readExactConfig(file);
  const existing = Array.isArray(cfg.exceptions) ? cfg.exceptions : [];
  const exceptions = [...existing.filter((e) => e?.category !== category), { category, reason: reason.trim() }];
  const next = { ...cfg, exceptions };
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

/**
 * Remove a project exception from `<cwd>/.inverita-guard.json`. A no-op (not
 * an error) if the file or the category isn't present.
 */
export function removeProjectException(cwd, category) {
  const dir = path.resolve(cwd);
  const file = path.join(dir, CONFIG_FILENAME);
  const cfg = readExactConfig(file);
  const existing = Array.isArray(cfg.exceptions) ? cfg.exceptions : [];
  const exceptions = existing.filter((e) => e?.category !== category);
  const removed = exceptions.length !== existing.length;
  if (removed) {
    fs.writeFileSync(file, `${JSON.stringify({ ...cfg, exceptions }, null, 2)}\n`);
  }
  return { removed };
}
