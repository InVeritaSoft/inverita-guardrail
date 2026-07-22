import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.resolve(HERE, '..', 'cli', 'inverita-guard.mjs');

function run(args, input) {
  return spawnSync('node', [BIN, ...args], { input, encoding: 'utf8' });
}

test('default mode with piped stdin runs the guard and blocks PHI', () => {
  const res = run([], JSON.stringify({ prompt: 'patient SSN is 123-45-6789', session_id: 's' }));
  assert.equal(res.status, 0);
  const out = JSON.parse(res.stdout);
  assert.equal(out.decision, 'block');
  assert.match(out.reason, /category: ssn_pattern/);
});

test('default mode passes a clean prompt', () => {
  const res = run([], JSON.stringify({ prompt: 'refactor the scheduler', session_id: 's' }));
  assert.equal(res.status, 0);
  const out = JSON.parse(res.stdout);
  assert.equal(out.decision, undefined);
  assert.match(out.hookSpecificOutput.additionalContext, /healthcare-data project/i);
});

test('--version prints a semver and exits 0', () => {
  const res = run(['--version']);
  assert.equal(res.status, 0);
  assert.match(res.stdout.trim(), /^\d+\.\d+\.\d+$/);
});

test('--help lists the subcommands and exits 0', () => {
  const res = run(['--help']);
  assert.equal(res.status, 0);
  assert.match(res.stdout, /inverita-guard/);
  assert.match(res.stdout, /check/);
  assert.match(res.stdout, /doctor/);
});

test('unknown command exits 2', () => {
  const res = run(['wat']);
  assert.equal(res.status, 2);
  assert.match(res.stderr, /unknown command/i);
});

test('check blocks PHI: exit 1 and reports category', () => {
  const res = run(['check', 'patient SSN is 123-45-6789']);
  assert.equal(res.status, 1);
  assert.match(res.stdout, /BLOCK/);
  assert.match(res.stdout, /ssn_pattern/);
});

test('check on a clean prompt: exit 0 and CLEAN', () => {
  const res = run(['check', 'refactor the scheduler']);
  assert.equal(res.status, 0);
  assert.match(res.stdout, /CLEAN/);
});

test('check --json emits a structured verdict', () => {
  const res = run(['check', '--json', 'prescribe 10mg twice daily']);
  assert.equal(res.status, 1);
  const out = JSON.parse(res.stdout);
  assert.equal(out.decision, 'block');
  assert.equal(out.tier, 2);
  assert.equal(out.category, 'medication_dosage');
});

test('doctor --json returns a result object and a nonzero exit when unwired', () => {
  const res = run(['doctor', '--json']);
  assert.ok(res.status === 0 || res.status === 1, 'doctor exits 0 or 1');
  const out = JSON.parse(res.stdout);
  assert.ok(Array.isArray(out.checks) && out.checks.length === 4);
  assert.equal(typeof out.ok, 'boolean');
});

test('install --managed prints valid managed settings JSON', () => {
  const res = run(['install', '--managed']);
  assert.equal(res.status, 0);
  const out = JSON.parse(res.stdout);
  assert.equal(out.allowManagedHooksOnly, true);
  assert.equal(out.hooks.UserPromptSubmit[0].hooks[0].command, 'inverita-guard');
});
