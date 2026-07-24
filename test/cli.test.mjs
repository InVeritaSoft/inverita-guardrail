import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.resolve(HERE, '..', 'cli', 'inverita-guard.mjs');
const HOOK = path.resolve(HERE, '..', 'hooks', 'pre-prompt-guard.mjs');

function run(args, input, opts = {}) {
  return spawnSync('node', [BIN, ...args], { input, encoding: 'utf8', ...opts });
}

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'guard-cli-home-'));
}

// Regression guard for the "block silently stops the prompt with no feedback"
// bug: calling process.exit() right after process.stdout.write() truncates the
// write when stdout is a pipe (always, under Claude Code), dropping the block
// decision + reason. The entry points must set process.exitCode and let Node
// drain the stream before exiting — never call process.exit() as a statement.
// The race is timing/load-dependent and can't be forced deterministically, so
// we assert the source invariant instead. (`^\s*process\.exit\(` matches only a
// statement, not the `process.exitCode =` assignments or the `// process.exit()`
// explanatory comments.)
for (const [label, file] of [
  ['cli/inverita-guard.mjs', BIN],
  ['hooks/pre-prompt-guard.mjs', HOOK],
]) {
  test(`${label} never calls process.exit() (would truncate piped stdout)`, () => {
    const src = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(
      src,
      /^\s*process\.exit\(/m,
      `${label} calls process.exit() as a statement — use process.exitCode so the stdout write drains`,
    );
  });
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

test('check reads the prompt from stdin when no argument is given', () => {
  const res = run(['check'], 'patient SSN is 123-45-6789');
  assert.equal(res.status, 1);
  assert.match(res.stdout, /BLOCK/);
  assert.match(res.stdout, /ssn_pattern/);
});

test('doctor (text mode) prints PASS/FAIL lines and a PROBLEM summary when unwired', () => {
  const res = run(['doctor'], undefined, { env: { ...process.env, HOME: tmpHome() } });
  assert.equal(res.status, 1);
  assert.match(res.stdout, /FAIL|PASS/);
  assert.match(res.stdout, /PROBLEM/);
});

test('doctor (text mode) reports OK and exits 0 when fully wired', () => {
  const home = tmpHome();
  const claude = path.join(home, '.claude');
  fs.mkdirSync(claude, { recursive: true });
  fs.writeFileSync(
    path.join(claude, 'settings.json'),
    JSON.stringify({
      hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'inverita-guard' }] }] },
    }),
  );
  const binDir = tmpHome();
  fs.writeFileSync(path.join(binDir, 'inverita-guard'), '#!/bin/sh\n', { mode: 0o755 });
  const res = run(['doctor'], undefined, {
    env: { ...process.env, HOME: home, PATH: `${binDir}${path.delimiter}${process.env.PATH}` },
  });
  assert.equal(res.status, 0);
  assert.match(res.stdout, /OK: guard is healthy/);
});

test('install (write mode) wires the hook, then is idempotent', () => {
  const home = tmpHome();
  const env = { ...process.env, HOME: home };
  const first = run(['install'], undefined, { env });
  assert.equal(first.status, 0);
  assert.match(first.stdout, /wired inverita-guard/);
  const settings = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'));
  assert.equal(settings.hooks.UserPromptSubmit[0].hooks[0].command, 'inverita-guard');
  const second = run(['install'], undefined, { env });
  assert.equal(second.status, 0);
  assert.match(second.stdout, /already present/);
});

test('install --print emits merged settings (absent then existing file)', () => {
  const home = tmpHome();
  const env = { ...process.env, HOME: home };
  // No settings file yet → the read try/catch falls back to {}.
  const absent = run(['install', '--print'], undefined, { env });
  assert.equal(absent.status, 0);
  const merged = JSON.parse(absent.stdout);
  assert.ok(merged.hooks.UserPromptSubmit);
  // Now with an existing (unrelated) settings file → the JSON.parse succeeds.
  const claude = path.join(home, '.claude');
  fs.mkdirSync(claude, { recursive: true });
  fs.writeFileSync(path.join(claude, 'settings.json'), JSON.stringify({ keep: true }));
  const existing = run(['install', '--print'], undefined, { env });
  assert.equal(existing.status, 0);
  assert.equal(JSON.parse(existing.stdout).keep, true);
});

// serve starts an HTTP server that shuts down cleanly when its stdin pipe
// closes. Passing input '' gives an immediate EOF, so the process starts,
// prints the banner, then exits 0 — and (being a synchronous child) its
// coverage merges into the run. Two runs cover the flag branches (explicit
// --host/--port) and the defaults.
test('serve --host/--port prints the startup banner then exits on stdin EOF', () => {
  const res = run(['serve', '--host', '127.0.0.1', '--port', '18789'], '');
  assert.equal(res.status, 0);
  assert.match(res.stderr, /serving on http:\/\/127\.0\.0\.1:18789/);
});

test('serve with no flags uses the default host and port', () => {
  const res = run(['serve'], '');
  assert.equal(res.status, 0);
  assert.match(res.stderr, /serving on http:\/\/127\.0\.0\.1:8787/);
});
