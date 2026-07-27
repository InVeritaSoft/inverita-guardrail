/**
 * Test suite for inverita-guardrail's pre-prompt-guard hook.
 *
 * Uses Node's built-in test runner (node:test) + node:assert — no third-party
 * dependencies, matching the plugin's zero-dep, stdlib-only design.
 *
 * Run with:  npm test     (or: node --test)
 *
 * Coverage:
 *   1. detect() unit tests — Layer 1 identifiers (tier 1 + category)
 *   2. detect() unit tests — Layer 2 clinical specifics (tier 2 + category)
 *   3. detect() unit tests — clean prompts return null (false-positive guards)
 *   4. Precedence — Layer 1 over Layer 2, lab_value over medication_dosage
 *   5. Hook I/O integration — block / clean / fail-open, always exit 0
 *   6. Audit log — metadata-only, no raw text, none written on clean prompts
 *   7. Audit log — size-cap rotation to audit.jsonl.1
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  detect,
  appendAudit,
  LAYER1,
  LAYER2,
  MRN_PATTERNS,
} from '../hooks/pre-prompt-guard.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.resolve(HERE, '..', 'hooks', 'pre-prompt-guard.mjs');
const MAX_LOG_BYTES = 5 * 1024 * 1024; // must match the hook's cap

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

// Run the hook as a child process with the given stdin, isolated to `root`
// (so audit writes never touch the real logs/ dir). `raw` overrides the
// JSON payload to exercise malformed input.
function runHook(prompt, { root, raw, sessionId = 'test-sess', mode = 'enforce' } = {}) {
  const input =
    raw !== undefined ? raw : JSON.stringify({ prompt, session_id: sessionId, cwd: '.' });
  const env = { ...process.env };
  if (root) env.CLAUDE_PLUGIN_ROOT = root;
  // Default to enforce so Layer 2 blocking is exercised (mirrors an org that
  // pins INVERITA_GUARD_MODE=enforce via managed settings). Advisory behavior
  // is covered by its own tests below.
  if (mode) env.INVERITA_GUARD_MODE = mode;
  const res = spawnSync('node', [HOOK], { input, encoding: 'utf8', env });
  return {
    status: res.status,
    stdout: res.stdout,
    stderr: res.stderr,
    json: res.stdout ? JSON.parse(res.stdout) : null,
  };
}

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'guardrail-test-'));
}

function readAudit(root) {
  const file = path.join(root, 'logs', 'audit.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

/* ------------------------------------------------------------------ *
 * 1. Layer 1 — identifiers (high confidence) -> tier 1
 * ------------------------------------------------------------------ */

const LAYER1_CASES = [
  ['ssn_pattern', 'patient SSN is 123-45-6789'],
  ['ssn_pattern', 'ssn 987-65-4321 on file'],
  ['mrn_pattern', 'MRN: 00847213 needs review'],
  ['mrn_pattern', 'medical record number 000123456'],
  ['mrn_pattern', 'patient id ABC1234567 attached'],
  ['dob_name_proximity', 'John Smith DOB 04/12/1970 follow-up'],
  ['dob_name_proximity', 'born on 1970-04-12, patient Jane Doe'],
  ['email_clinical', 'email jane.doe@acme.com re: patient diagnosis'],
  ['email_clinical', 'contact bob@example.org about the dx'],
  ['insurance_policy', 'policy number XYZ8841203 on file'],
  ['insurance_policy', 'member id 998877665 verified'],
];

test('Layer 1 identifiers block as tier 1 with the right category', () => {
  for (const [category, prompt] of LAYER1_CASES) {
    const hit = detect(prompt);
    assert.ok(hit, `expected a match for: ${prompt}`);
    assert.equal(hit.tier, 1, `expected tier 1 for: ${prompt}`);
    assert.equal(hit.category, category, `wrong category for: ${prompt}`);
    assert.match(hit.reason, /identifier detected/, 'reason should frame as identifier');
    assert.match(hit.reason, new RegExp(`category: ${category}`));
  }
});

/* ------------------------------------------------------------------ *
 * 2. Layer 2 — clinical specifics (broad net) -> tier 2
 * ------------------------------------------------------------------ */

const LAYER2_CASES = [
  ['icd_code', 'map the field for E11.9'],
  ['icd_code', 'diagnosis code I10 in the seed'],
  ['icd_code', 'handle J45.909 in the parser'],
  ['medication_dosage', 'prescribe 10mg twice daily'],
  ['medication_dosage', 'take 500mcg of the compound'],
  ['medication_dosage', '2x daily dosing schedule'],
  ['lab_value', 'glucose reading was 126 mg/dL'],
  ['lab_value', 'blood pressure 140/90 mmHg'],
  ['lab_value', 'A1c 7.2 last visit'],
  ['clinical_narrative', 'chief complaint: chest pain'],
  ['clinical_narrative', 'patient presented with fever'],
  ['clinical_narrative', 'history of diabetes and smoking'],
  ['clinical_narrative', 'c/o nausea since morning'],
  ['age_condition', '68 year old male with COPD'],
  ['age_condition', '45yo with hypertension'],
  ['age_condition', '30yof presents to clinic'],
];

test('Layer 2 clinical specifics block as tier 2 with the right category', () => {
  for (const [category, prompt] of LAYER2_CASES) {
    const hit = detect(prompt);
    assert.ok(hit, `expected a match for: ${prompt}`);
    assert.equal(hit.tier, 2, `expected tier 2 for: ${prompt}`);
    assert.equal(hit.category, category, `wrong category for: ${prompt}`);
    assert.match(hit.reason, /clinical specificity detected/, 'reason should frame as clinical specificity');
    assert.match(hit.reason, new RegExp(`category: ${category}`));
  }
});

/* ------------------------------------------------------------------ *
 * 3. Clean prompts -> null (false-positive guards)
 * ------------------------------------------------------------------ */

const CLEAN_CASES = [
  'refactor the appointment scheduler component',
  'use synthetic patient PT-0001 in the fixture',
  'patient id: PT-0001',                       // short synthetic id, not an MRN
  'git history of the auth module',            // "history of" without clinical companion
  'increase padding to 8px and margin to 4px', // px is not a dose unit
  'the 5G network rollout plan',               // bare "g" is not a dose unit
  'review the patient portal login flow',      // "patient" alone (no email) is fine
  'the diagnosis feature needs a fix',         // "diagnosis" alone (no email) is fine
  'deploy version 2 to staging today',
];

test('clean developer prompts do not match either tier', () => {
  for (const prompt of CLEAN_CASES) {
    assert.equal(detect(prompt), null, `false positive on: ${prompt}`);
  }
});

test('empty / non-string prompts return null', () => {
  assert.equal(detect(''), null);
  assert.equal(detect(undefined), null);
  assert.equal(detect(null), null);
  assert.equal(detect(42), null);
});

/* ------------------------------------------------------------------ *
 * 4. Precedence
 * ------------------------------------------------------------------ */

test('Layer 1 takes precedence over Layer 2', () => {
  const hit = detect('patient SSN 123-45-6789, prescribe 10mg daily');
  assert.equal(hit.tier, 1);
  assert.equal(hit.category, 'ssn_pattern');
});

test('lab_value is chosen over medication_dosage for concentration units', () => {
  // "126 mg" alone looks like a dose, but "126 mg/dL" is a lab concentration.
  const hit = detect('glucose 126 mg/dL');
  assert.equal(hit.category, 'lab_value');
});

/* ------------------------------------------------------------------ *
 * Config shape sanity — makes the tuning surface hard to break silently
 * ------------------------------------------------------------------ */

test('LAYER1 / LAYER2 / MRN_PATTERNS have the expected shape', () => {
  assert.ok(Array.isArray(MRN_PATTERNS) && MRN_PATTERNS.length > 0);
  for (const re of MRN_PATTERNS) assert.ok(re instanceof RegExp);
  for (const set of [LAYER1, LAYER2]) {
    assert.ok(Array.isArray(set) && set.length > 0);
    for (const rule of set) {
      assert.equal(typeof rule.category, 'string');
      assert.equal(typeof rule.body, 'string');
      assert.equal(typeof rule.match, 'function');
    }
  }
  // Categories are unique within each tier.
  const cats1 = LAYER1.map((r) => r.category);
  const cats2 = LAYER2.map((r) => r.category);
  assert.equal(new Set(cats1).size, cats1.length);
  assert.equal(new Set(cats2).size, cats2.length);
});

/* ------------------------------------------------------------------ *
 * 5. Hook I/O integration (child process, real stdin/stdout)
 * ------------------------------------------------------------------ */

test('hook blocks a Layer 1 prompt via decision JSON, exit 0', () => {
  const root = tmpRoot();
  const { status, json } = runHook('patient SSN is 123-45-6789', { root });
  assert.equal(status, 0, 'hook must exit 0 even when blocking');
  assert.equal(json.decision, 'block');
  assert.match(json.reason, /category: ssn_pattern/);
});

test('hook blocks a Layer 2 prompt via decision JSON, exit 0', () => {
  const root = tmpRoot();
  const { status, json } = runHook('prescribe 10mg twice daily', { root });
  assert.equal(status, 0);
  assert.equal(json.decision, 'block');
  assert.match(json.reason, /category: medication_dosage/);
});

test('hook passes a clean prompt with additionalContext reminder, exit 0', () => {
  const root = tmpRoot();
  const { status, json } = runHook('refactor the scheduler component', { root });
  assert.equal(status, 0);
  assert.equal(json.decision, undefined, 'clean prompt must not carry a block decision');
  assert.equal(json.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.match(json.hookSpecificOutput.additionalContext, /healthcare-data project/i);
});

test('hook fails open with a warning on malformed stdin, exit 0', () => {
  const root = tmpRoot();
  const { status, json } = runHook(null, { root, raw: 'this is not json' });
  assert.equal(status, 0, 'malformed input must never brick the prompt');
  assert.equal(json.decision, undefined);
  assert.match(json.hookSpecificOutput.additionalContext, /could not be read/i);
});

test('hook fails open on empty stdin, exit 0', () => {
  const root = tmpRoot();
  const { status, json } = runHook(null, { root, raw: '' });
  assert.equal(status, 0);
  assert.equal(json.decision, undefined);
  assert.ok(json.hookSpecificOutput.additionalContext);
});

test('valid JSON with a missing/non-string prompt is treated as clean, exit 0', () => {
  const root = tmpRoot();
  const { status, json } = runHook(null, { root, raw: JSON.stringify({ session_id: 'x' }) });
  assert.equal(status, 0);
  assert.equal(json.decision, undefined);
  assert.ok(json.hookSpecificOutput.additionalContext);
});

/* ------------------------------------------------------------------ *
 * 5b. Mode: advisory downgrades Layer 2 to a warning; Layer 1 still blocks
 * ------------------------------------------------------------------ */

test('advisory mode does NOT block a Layer 2 prompt — it injects a caution', () => {
  const root = tmpRoot();
  const { status, json } = runHook('prescribe 10mg twice daily', { root, mode: 'advisory' });
  assert.equal(status, 0);
  assert.equal(json.decision, undefined, 'advisory Layer 2 must not carry a block decision');
  assert.match(json.hookSpecificOutput.additionalContext, /Advisory \(mode: advisory\)/);
  assert.match(json.hookSpecificOutput.additionalContext, /category: medication_dosage/);
});

test('advisory mode still hard-blocks a Layer 1 identifier', () => {
  const root = tmpRoot();
  const { status, json } = runHook('patient SSN is 123-45-6789', { root, mode: 'advisory' });
  assert.equal(status, 0);
  assert.equal(json.decision, 'block', 'Layer 1 identifiers block in every mode');
  assert.match(json.reason, /category: ssn_pattern/);
});

test('advisory Layer 2 audits action=warn (not a block)', () => {
  const root = tmpRoot();
  runHook('68 year old male with COPD', { root, mode: 'advisory' });
  const [rec] = readAudit(root);
  assert.equal(rec.tier, 2);
  assert.equal(rec.mode, 'advisory');
  assert.equal(rec.action, 'warn');
});

/* ------------------------------------------------------------------ *
 * 6. Audit log — metadata only, never raw text
 * ------------------------------------------------------------------ */

test('a block writes exactly one metadata-only audit record', () => {
  const root = tmpRoot();
  runHook('patient SSN is 123-45-6789', { root, sessionId: 'sess-42' });
  const records = readAudit(root);
  assert.equal(records.length, 1);
  const rec = records[0];
  assert.deepEqual(
    Object.keys(rec).sort(),
    ['action', 'category', 'mode', 'session_id', 'tier', 'ts'],
  );
  assert.equal(rec.session_id, 'sess-42');
  assert.equal(rec.tier, 1);
  assert.equal(rec.category, 'ssn_pattern');
  assert.equal(rec.mode, 'enforce');
  assert.equal(rec.action, 'block');
  assert.equal(typeof rec.ts, 'string');
  assert.ok(!Number.isNaN(Date.parse(rec.ts)), 'ts must be a valid ISO timestamp');
});

test('audit log never contains the raw prompt or matched text', () => {
  const root = tmpRoot();
  const secret = '123-45-6789';
  runHook(`the patient SSN ${secret} must not be logged`, { root });
  const raw = fs.readFileSync(path.join(root, 'logs', 'audit.jsonl'), 'utf8');
  assert.ok(!raw.includes(secret), 'matched SSN leaked into audit log');
  assert.ok(!raw.includes('must not be logged'), 'prompt text leaked into audit log');
});

test('clean prompts write no audit record', () => {
  const root = tmpRoot();
  runHook('refactor the scheduler component', { root });
  assert.equal(readAudit(root).length, 0, 'clean prompt must not be audited');
});

test('a Layer 2 block records tier 2 and its category', () => {
  const root = tmpRoot();
  runHook('68 year old male with COPD', { root });
  const [rec] = readAudit(root);
  assert.equal(rec.tier, 2);
  assert.equal(rec.category, 'age_condition');
});

/* ------------------------------------------------------------------ *
 * 7. Audit log rotation at the size cap
 * ------------------------------------------------------------------ */

test('audit log rotates to .1 once it exceeds the size cap', () => {
  const root = tmpRoot();
  const logDir = path.join(root, 'logs');
  const logFile = path.join(logDir, 'audit.jsonl');
  fs.mkdirSync(logDir, { recursive: true });
  // Seed an oversized current log.
  fs.writeFileSync(logFile, 'x'.repeat(MAX_LOG_BYTES + 10));

  const prevRoot = process.env.CLAUDE_PLUGIN_ROOT;
  process.env.CLAUDE_PLUGIN_ROOT = root;
  try {
    appendAudit({ session_id: 's', tier: 1, category: 'ssn_pattern' }, '2026-07-15T00:00:00.000Z');
  } finally {
    if (prevRoot === undefined) delete process.env.CLAUDE_PLUGIN_ROOT;
    else process.env.CLAUDE_PLUGIN_ROOT = prevRoot;
  }

  assert.ok(fs.existsSync(`${logFile}.1`), 'oversized log should rotate to audit.jsonl.1');
  const current = readAudit(root);
  assert.equal(current.length, 1, 'current log should hold only the post-rotation record');
  assert.equal(current[0].category, 'ssn_pattern');
});
