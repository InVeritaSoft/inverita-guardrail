import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Isolate override state per test run — must be set before importing the module,
// which reads INVERITA_GUARD_STATE_DIR lazily on each call.
const STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'inv-guard-state-'));
process.env.INVERITA_GUARD_STATE_DIR = STATE_DIR;

const {
  OVERRIDE_PHRASE,
  OVERRIDE_TTL_MS,
  containsOverridePhrase,
  isOverrideEnabled,
  grantOverride,
  isOverrideActive,
  overrideRemainingMs,
  revokeOverride,
} = await import('../src/override.mjs');

/* ---------------- the attestation phrase ---------------- */

test('phrase matches the documented attestation verbatim', () => {
  assert.ok(containsOverridePhrase(OVERRIDE_PHRASE));
});

test('phrase matching is case- and whitespace-forgiving', () => {
  assert.ok(containsOverridePhrase('i confirm this prompt contains no real phi'));
  assert.ok(containsOverridePhrase('I CONFIRM THIS PROMPT CONTAINS NO REAL PHI'));
  assert.ok(containsOverridePhrase('I confirm this prompt\n  contains   no real PHI'));
});

test('phrase is found inside a larger prompt', () => {
  assert.ok(
    containsOverridePhrase('here is my log paste\nI confirm this prompt contains no real PHI\nthanks'),
  );
});

test('phrase must be typed on purpose — near misses do not count', () => {
  assert.ok(!containsOverridePhrase('I confirm this contains no real PHI'), 'missing "prompt"');
  assert.ok(!containsOverridePhrase('this prompt contains no real PHI'), 'missing "I confirm"');
  assert.ok(!containsOverridePhrase('no real PHI here'));
  assert.ok(!containsOverridePhrase('skip'));
  assert.ok(!containsOverridePhrase(''));
  assert.ok(!containsOverridePhrase(undefined));
});

/* ---------------- org kill switch ---------------- */

test('override is available by default', () => {
  assert.ok(isOverrideEnabled({}));
  assert.ok(isOverrideEnabled({ INVERITA_GUARD_ALLOW_OVERRIDE: '1' }));
  assert.ok(isOverrideEnabled(undefined));
});

test('an org can disable the override fleet-wide', () => {
  for (const v of ['0', 'false', 'no', 'off', 'FALSE', ' Off ']) {
    assert.equal(isOverrideEnabled({ INVERITA_GUARD_ALLOW_OVERRIDE: v }), false, `value: ${v}`);
  }
});

/* ---------------- session scoping and expiry ---------------- */

test('granting unlocks that session and only that session', () => {
  const now = 1_000_000;
  grantOverride('sess-A', now);
  assert.ok(isOverrideActive('sess-A', now + 1000));
  assert.ok(!isOverrideActive('sess-B', now + 1000), 'another session must be unaffected');
});

test('an unlock expires after the TTL', () => {
  const now = 2_000_000;
  grantOverride('sess-ttl', now);
  assert.ok(isOverrideActive('sess-ttl', now + OVERRIDE_TTL_MS - 1), 'active just before expiry');
  assert.ok(!isOverrideActive('sess-ttl', now + OVERRIDE_TTL_MS), 'expired exactly at the cap');
  assert.ok(!isOverrideActive('sess-ttl', now + OVERRIDE_TTL_MS + 60_000), 'stays expired');
});

test('TTL is the documented 60 minutes', () => {
  assert.equal(OVERRIDE_TTL_MS, 60 * 60 * 1000);
});

test('re-attesting refreshes the window from now', () => {
  const now = 3_000_000;
  grantOverride('sess-refresh', now);
  const later = now + OVERRIDE_TTL_MS - 1000;
  grantOverride('sess-refresh', later);
  assert.ok(isOverrideActive('sess-refresh', later + OVERRIDE_TTL_MS - 1));
});

test('remaining time counts down and floors at zero', () => {
  const now = 4_000_000;
  grantOverride('sess-remain', now);
  assert.equal(overrideRemainingMs('sess-remain', now), OVERRIDE_TTL_MS);
  assert.equal(overrideRemainingMs('sess-remain', now + 1000), OVERRIDE_TTL_MS - 1000);
  assert.equal(overrideRemainingMs('sess-remain', now + OVERRIDE_TTL_MS), 0);
  assert.equal(overrideRemainingMs('nope', now), 0);
});

test('an unlock can be revoked early', () => {
  const now = 5_000_000;
  grantOverride('sess-revoke', now);
  assert.ok(isOverrideActive('sess-revoke', now));
  assert.deepEqual(revokeOverride('sess-revoke', now), { revoked: true });
  assert.ok(!isOverrideActive('sess-revoke', now));
  assert.deepEqual(revokeOverride('sess-revoke', now), { revoked: false }, 'revoking twice is a no-op');
});

test('a missing session id never unlocks anything', () => {
  assert.equal(grantOverride('', 6_000_000), null);
  assert.ok(!isOverrideActive('', 6_000_000));
  assert.ok(!isOverrideActive(undefined, 6_000_000));
});

/* ---------------- state hygiene ---------------- */

test('state stores only session ids and expiry timestamps — never prompt text', () => {
  const now = 7_000_000;
  grantOverride('sess-hygiene', now);
  const raw = fs.readFileSync(path.join(STATE_DIR, 'overrides.json'), 'utf8');
  const parsed = JSON.parse(raw);
  for (const [id, expiresAt] of Object.entries(parsed)) {
    assert.equal(typeof id, 'string');
    assert.equal(typeof expiresAt, 'number', 'values must be timestamps, not content');
  }
  assert.doesNotMatch(raw, /PHI|prompt|patient/i);
});

test('expired entries are pruned on the next write', () => {
  const now = 8_000_000;
  grantOverride('sess-old', now);
  // Far enough ahead that sess-old is long expired when the next grant writes.
  const muchLater = now + OVERRIDE_TTL_MS * 2;
  grantOverride('sess-new', muchLater);
  const parsed = JSON.parse(fs.readFileSync(path.join(STATE_DIR, 'overrides.json'), 'utf8'));
  assert.ok(!('sess-old' in parsed), 'expired session must be pruned');
  assert.ok('sess-new' in parsed);
});

test('unreadable state fails safe (locked), never throws', () => {
  const prev = process.env.INVERITA_GUARD_STATE_DIR;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inv-guard-bad-'));
  fs.writeFileSync(path.join(dir, 'overrides.json'), 'not json at all');
  process.env.INVERITA_GUARD_STATE_DIR = dir;
  try {
    assert.doesNotThrow(() => isOverrideActive('anything', Date.now()));
    assert.equal(isOverrideActive('anything', Date.now()), false, 'corrupt state must not unlock');
  } finally {
    process.env.INVERITA_GUARD_STATE_DIR = prev;
  }
});
