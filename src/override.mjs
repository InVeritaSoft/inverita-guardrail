/**
 * inverita-guardrail :: break-glass override
 * ------------------------------------------
 * A developer-initiated, session-scoped, time-capped, audited bypass of the
 * detector — including Layer 1.
 *
 * WHY THIS EXISTS, AND WHY IT IS DANGEROUS
 * ----------------------------------------
 * Until now Layer 1 was an absolute floor with no local override. That is the
 * right default, but an absolute floor with a false-positive rate is worse than
 * a controlled override: a developer blocked from pasting a log they know is
 * PHI-free does not shrug and move on — they paste it into a file, or turn the
 * guard off, or stop using the tool. A bypass that leaves an audit trail beats
 * a bypass that routes around the guard entirely and leaves nothing.
 *
 * So this is a deliberate loosening of the safety floor, approved by the
 * compliance owner, and it is designed to be EXPENSIVE rather than convenient:
 *
 *  - The phrase is an ATTESTATION, not a token. Typing "I confirm this prompt
 *    contains no real PHI" is a statement a named developer makes, recorded
 *    against their session id. `#skip` would become muscle memory; a sentence
 *    does not.
 *  - It is SESSION-SCOPED. Another session, another developer, another machine:
 *    unaffected.
 *  - It EXPIRES after 60 minutes regardless of session length, because Claude
 *    Code sessions routinely stay open for days and an uncapped unlock is
 *    indistinguishable from disabling the guard.
 *  - An org can REMOVE it fleet-wide with INVERITA_GUARD_ALLOW_OVERRIDE=0 in
 *    managed settings, exactly as INVERITA_GUARD_MODE pins enforcement. Without
 *    that, managed enforcement would be unenforceable.
 *  - Every grant and every overridden prompt is AUDITED. The audit log stays
 *    metadata-only — the attestation is recorded, never the prompt text.
 *
 * This file stores no prompt content, only { session_id -> expires_at }.
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

/** The attestation a developer must type verbatim (matching is forgiving). */
export const OVERRIDE_PHRASE = 'I confirm this prompt contains no real PHI';

/** Hard ceiling on an unlock, regardless of how long the session lives. */
export const OVERRIDE_TTL_MS = 60 * 60 * 1000;

/**
 * Forgiving match: case-insensitive, any run of whitespace between words, so a
 * wrapped or re-indented paste still counts. Deliberately NOT forgiving about
 * the words themselves — this has to be typed on purpose.
 */
const PHRASE_RE = /i\s+confirm\s+this\s+prompt\s+contains\s+no\s+real\s+phi/i;

export function containsOverridePhrase(text) {
  return typeof text === 'string' && PHRASE_RE.test(text);
}

/**
 * Whether the override mechanism exists at all here. An org disables it by
 * setting INVERITA_GUARD_ALLOW_OVERRIDE to 0/false/no/off in managed settings;
 * anything else (including unset) leaves it available.
 */
export function isOverrideEnabled(env) {
  const raw = env?.INVERITA_GUARD_ALLOW_OVERRIDE;
  if (raw === undefined || raw === null) return true;
  return !['0', 'false', 'no', 'off'].includes(String(raw).trim().toLowerCase());
}

/* ------------------------------------------------------------------ *
 * State — { session_id: expires_at }, metadata only, never prompt text
 * ------------------------------------------------------------------ */

function stateDir() {
  if (process.env.INVERITA_GUARD_STATE_DIR) return process.env.INVERITA_GUARD_STATE_DIR;
  const root =
    process.env.CLAUDE_PLUGIN_ROOT ||
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  return path.join(root, 'state');
}

function stateFile() {
  return path.join(stateDir(), 'overrides.json');
}

function readState() {
  try {
    const obj = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
    return obj && typeof obj === 'object' ? obj : {};
  } catch {
    return {};
  }
}

/**
 * Persist state, dropping anything already expired so the file cannot grow
 * without bound. Failures are swallowed: a state write must never be able to
 * break the guard (the fail-safe direction is "override not granted", which
 * simply means the prompt stays blocked).
 */
function writeState(state, now) {
  try {
    const live = {};
    for (const [id, expiresAt] of Object.entries(state)) {
      if (typeof expiresAt === 'number' && expiresAt > now) live[id] = expiresAt;
    }
    fs.mkdirSync(stateDir(), { recursive: true });
    fs.writeFileSync(stateFile(), `${JSON.stringify(live)}\n`);
    return live;
  } catch {
    return state;
  }
}

/**
 * Start (or restart) an unlock for `sessionId`. Returns the expiry timestamp.
 * Re-attesting refreshes the window rather than extending it indefinitely.
 */
export function grantOverride(sessionId, now = Date.now()) {
  if (!sessionId) return null;
  const expiresAt = now + OVERRIDE_TTL_MS;
  const state = readState();
  state[sessionId] = expiresAt;
  writeState(state, now);
  return expiresAt;
}

/** Whether `sessionId` currently holds an unexpired unlock. */
export function isOverrideActive(sessionId, now = Date.now()) {
  if (!sessionId) return false;
  const expiresAt = readState()[sessionId];
  return typeof expiresAt === 'number' && expiresAt > now;
}

/** Remaining milliseconds on an unlock, or 0 when none is active. */
export function overrideRemainingMs(sessionId, now = Date.now()) {
  if (!sessionId) return 0;
  const expiresAt = readState()[sessionId];
  if (typeof expiresAt !== 'number' || expiresAt <= now) return 0;
  return expiresAt - now;
}

/** End an unlock early. A no-op when none is active. */
export function revokeOverride(sessionId, now = Date.now()) {
  const state = readState();
  if (!(sessionId in state)) return { revoked: false };
  delete state[sessionId];
  writeState(state, now);
  return { revoked: true };
}
