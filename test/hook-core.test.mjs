import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { processHookInput, appendAudit } from '../hooks/pre-prompt-guard.mjs';

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

test('processHookInput fails open on malformed input', () => {
  const { stdout } = processHookInput('not json');
  const out = JSON.parse(stdout);
  assert.equal(out.decision, undefined);
  assert.match(out.hookSpecificOutput.additionalContext, /could not be read/i);
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
