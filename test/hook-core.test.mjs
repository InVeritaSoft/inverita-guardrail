import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { processHookInput, appendAudit, decideAction } from '../hooks/pre-prompt-guard.mjs';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'guard-core-'));
}

test('processHookInput blocks a Layer 1 prompt', () => {
  const { stdout } = processHookInput(
    JSON.stringify({ prompt: 'patient SSN is 123-45-6789', session_id: 's' }),
  );
  const out = JSON.parse(stdout);
  assert.equal(out.decision, 'block');
  assert.match(out.reason, /category: ssn_pattern/);
});

test('processHookInput passes a clean prompt with additionalContext', () => {
  const { stdout } = processHookInput(
    JSON.stringify({ prompt: 'refactor the scheduler', session_id: 's' }),
  );
  const out = JSON.parse(stdout);
  assert.equal(out.decision, undefined);
  assert.equal(out.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.match(out.hookSpecificOutput.additionalContext, /healthcare-data project/i);
});

test('decideAction: null on no hit, Layer 1 always blocks, Layer 2 depends on mode', () => {
  assert.equal(decideAction(null, 'enforce'), null);
  assert.equal(decideAction({ tier: 1 }, 'advisory'), 'block');
  assert.equal(decideAction({ tier: 1 }, 'enforce'), 'block');
  assert.equal(decideAction({ tier: 2 }, 'enforce'), 'block');
  assert.equal(decideAction({ tier: 2 }, 'advisory'), 'warn');
});

test('processHookInput handles a payload with no cwd (mode resolves without it)', () => {
  // Layer 1 blocks regardless of mode; exercises the cwd-absent branch.
  const { stdout } = processHookInput(JSON.stringify({ prompt: 'SSN 123-45-6789' }));
  assert.equal(JSON.parse(stdout).decision, 'block');
});

test('processHookInput fails open on malformed input', () => {
  const { stdout } = processHookInput('not json');
  const out = JSON.parse(stdout);
  assert.equal(out.decision, undefined);
  assert.match(out.hookSpecificOutput.additionalContext, /could not be read/i);
});

test('processHookInput fails open when the parsed payload is not an object', () => {
  // Valid JSON (`null`) parses, then reading `.prompt` throws — the inner
  // try/catch must still fail open rather than crash the hook.
  const { stdout } = processHookInput('null');
  const out = JSON.parse(stdout);
  assert.equal(out.decision, undefined);
  assert.match(out.hookSpecificOutput.additionalContext, /could not be read/i);
});

test('processHookInput defaults missing prompt/session_id fields', () => {
  // Exercises the false branches of the prompt/session_id type guards: an
  // object with neither field is treated as an empty, clean prompt.
  const { stdout } = processHookInput(JSON.stringify({ other: 1 }));
  const out = JSON.parse(stdout);
  assert.equal(out.decision, undefined);
  assert.match(out.hookSpecificOutput.additionalContext, /healthcare-data project/i);
});

test('appendAudit swallows filesystem errors (best-effort logging)', () => {
  // Point the log dir at a path whose parent is a regular file so mkdirSync
  // throws ENOTDIR — the catch must swallow it and return without throwing.
  const base = tmpDir();
  const notADir = path.join(base, 'blocker');
  fs.writeFileSync(notADir, 'x');
  const prev = process.env.INVERITA_GUARD_LOG_DIR;
  process.env.INVERITA_GUARD_LOG_DIR = path.join(notADir, 'sub');
  try {
    assert.doesNotThrow(() =>
      appendAudit({ session_id: 's', tier: 1, category: 'ssn_pattern' }, '2026-07-24T00:00:00.000Z'),
    );
  } finally {
    if (prev === undefined) delete process.env.INVERITA_GUARD_LOG_DIR;
    else process.env.INVERITA_GUARD_LOG_DIR = prev;
  }
});

test('appendAudit honors INVERITA_GUARD_LOG_DIR override', () => {
  const dir = tmpDir();
  const prev = process.env.INVERITA_GUARD_LOG_DIR;
  process.env.INVERITA_GUARD_LOG_DIR = dir;
  try {
    appendAudit({ session_id: 's', tier: 1, category: 'ssn_pattern' }, '2026-07-22T00:00:00.000Z');
  } finally {
    if (prev === undefined) delete process.env.INVERITA_GUARD_LOG_DIR;
    else process.env.INVERITA_GUARD_LOG_DIR = prev;
  }
  const rec = JSON.parse(fs.readFileSync(path.join(dir, 'audit.jsonl'), 'utf8').trim());
  assert.equal(rec.category, 'ssn_pattern');
});
