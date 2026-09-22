import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runDoctor, whichInveritaGuard, hookWiredIn, probeDispatch } from '../src/doctor.mjs';

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'guard-doctor-'));
}

// A probe stub that pretends the CLI dispatched and blocked (the healthy case),
// so tests need not spawn a real subprocess.
const blockingProbe = () => ({ stdout: JSON.stringify({ decision: 'block' }), status: 0, error: null });

test('hookWiredIn detects a UserPromptSubmit hook referencing inverita-guard', () => {
  const settings = {
    hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'inverita-guard' }] }] },
  };
  assert.equal(hookWiredIn(settings), true);
  assert.equal(hookWiredIn({ hooks: {} }), false);
  assert.equal(hookWiredIn({}), false);
});

test('whichInveritaGuard finds the binary on a synthetic PATH', () => {
  const dir = tmp();
  const bin = path.join(dir, 'inverita-guard');
  fs.writeFileSync(bin, '#!/bin/sh\n', { mode: 0o755 });
  const found = whichInveritaGuard({ PATH: dir }, 'linux');
  assert.equal(found, bin);
  assert.equal(whichInveritaGuard({ PATH: tmp() }, 'linux'), null);
});

test('whichInveritaGuard resolves win32 names via the Path env var', () => {
  const dir = tmp();
  const bin = path.join(dir, 'inverita-guard.cmd');
  fs.writeFileSync(bin, '@echo off\n');
  // win32 uses ';' as the separator and the `Path` (not `PATH`) casing.
  const found = whichInveritaGuard({ Path: dir }, 'win32');
  assert.equal(found, bin);
  // Empty PATH → nothing to scan → null.
  assert.equal(whichInveritaGuard({}, 'linux'), null);
});

test('runDoctor picks the darwin and win32 managed-settings paths', () => {
  // These platforms just change which managed-settings path is probed; with no
  // wired hook anywhere the run is not ok, but the platform branch is taken.
  for (const platform of ['darwin', 'win32']) {
    const res = runDoctor({
      env: { PATH: tmp() },
      homedir: tmp(),
      cwd: tmp(),
      platform,
      nodeVersion: 'v20.0.0',
    });
    assert.equal(res.ok, false);
    assert.equal(res.checks.length, 6);
  }
});

test('runDoctor flags an unsupported node version', () => {
  const res = runDoctor({
    env: { PATH: tmp() },
    homedir: tmp(),
    cwd: tmp(),
    platform: 'linux',
    nodeVersion: 'v16.20.0',
  });
  assert.equal(res.checks[0].ok, false);
});

test('runDoctor is ok when all checks pass', () => {
  const home = tmp();
  const claude = path.join(home, '.claude');
  fs.mkdirSync(claude, { recursive: true });
  fs.writeFileSync(
    path.join(claude, 'settings.json'),
    JSON.stringify({
      hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'inverita-guard' }] }] },
    }),
  );
  const pathDir = tmp();
  fs.writeFileSync(path.join(pathDir, 'inverita-guard'), '#!/bin/sh\n', { mode: 0o755 });

  const res = runDoctor({
    env: { PATH: pathDir },
    homedir: home,
    cwd: tmp(),
    platform: 'linux',
    nodeVersion: 'v18.19.0',
    probe: blockingProbe,
  });
  assert.equal(res.ok, true);
  assert.equal(res.checks.length, 5);
});

test('runDoctor flags a misbehaving detector via the smoke-test check', () => {
  // Inject a detector that never blocks — the smoke test must fail.
  const res = runDoctor({
    env: { PATH: tmp() },
    homedir: tmp(),
    cwd: tmp(),
    platform: 'linux',
    nodeVersion: 'v20.0.0',
    detect: () => null,
  });
  const smoke = res.checks.find((c) => c.name === 'detector smoke test');
  assert.equal(smoke.ok, false);
  assert.match(smoke.detail, /misbehaving/);
});

test('runDoctor fails when the hook is not wired', () => {
  const res = runDoctor({
    env: { PATH: tmp() },
    homedir: tmp(),
    cwd: tmp(),
    platform: 'linux',
    nodeVersion: 'v18.0.0',
  });
  assert.equal(res.ok, false);
});

function withBin() {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'inverita-guard'), '#!/bin/sh\n', { mode: 0o755 });
  return dir;
}

test('dispatch check is skipped (not ok) when the CLI is not on PATH', () => {
  const res = runDoctor({
    env: { PATH: tmp() }, // empty → no bin
    homedir: tmp(),
    cwd: tmp(),
    platform: 'linux',
    nodeVersion: 'v20.0.0',
  });
  const d = res.checks.find((c) => c.name === 'CLI dispatches (end-to-end)');
  assert.equal(d.ok, false);
  assert.match(d.detail, /not on PATH/);
});

test('dispatch check fails on a silent no-op (empty stdout — the original bug)', () => {
  const res = runDoctor({
    env: { PATH: withBin() },
    homedir: tmp(),
    cwd: tmp(),
    platform: 'linux',
    nodeVersion: 'v20.0.0',
    probe: () => ({ stdout: '', status: 0, error: null }), // dispatched nothing
  });
  const d = res.checks.find((c) => c.name === 'CLI dispatches (end-to-end)');
  assert.equal(d.ok, false);
  assert.match(d.detail, /did not block/);
});

test('dispatch check reports a probe that could not run the CLI', () => {
  const res = runDoctor({
    env: { PATH: withBin() },
    homedir: tmp(),
    cwd: tmp(),
    platform: 'linux',
    nodeVersion: 'v20.0.0',
    probe: () => ({ stdout: '', status: null, error: new Error('ENOENT') }),
  });
  const d = res.checks.find((c) => c.name === 'CLI dispatches (end-to-end)');
  assert.equal(d.ok, false);
  assert.match(d.detail, /could not run CLI: ENOENT/);
});

test('dispatch check surfaces a probe that throws', () => {
  const res = runDoctor({
    env: { PATH: withBin() },
    homedir: tmp(),
    cwd: tmp(),
    platform: 'linux',
    nodeVersion: 'v20.0.0',
    probe: () => {
      throw new Error('boom');
    },
  });
  const d = res.checks.find((c) => c.name === 'CLI dispatches (end-to-end)');
  assert.equal(d.ok, false);
  assert.match(d.detail, /probe threw: boom/);
});

test('probeDispatch on a missing binary returns empty stdout, null status, an error', () => {
  // Exercises the defensive fallbacks (stdout||'', status??null, error||null)
  // via a real spawn that fails to exec.
  const r = probeDispatch(path.join(tmp(), 'nope-not-here'));
  assert.equal(r.stdout, '');
  assert.equal(r.status, null);
  assert.ok(r.error, 'spawn error is surfaced');
});

test('dispatch check falls back to the raw error when it has no .message', () => {
  const res = runDoctor({
    env: { PATH: withBin() },
    homedir: tmp(),
    cwd: tmp(),
    platform: 'linux',
    nodeVersion: 'v20.0.0',
    probe: () => ({ stdout: '', status: null, error: 'bare-string-error' }),
  });
  const d = res.checks.find((c) => c.name === 'CLI dispatches (end-to-end)');
  assert.match(d.detail, /could not run CLI: bare-string-error/);
});

test('dispatch check treats a JSON "null" body as a non-block (no-op)', () => {
  const res = runDoctor({
    env: { PATH: withBin() },
    homedir: tmp(),
    cwd: tmp(),
    platform: 'linux',
    nodeVersion: 'v20.0.0',
    probe: () => ({ stdout: 'null', status: 0, error: null }),
  });
  const d = res.checks.find((c) => c.name === 'CLI dispatches (end-to-end)');
  assert.equal(d.ok, false);
  assert.match(d.detail, /did not block/);
});

test('probeDispatch actually runs the real CLI end-to-end and blocks PHI', () => {
  // No stub: spawn the genuine executable CLI (shebang) so the real dispatch
  // path — the one that silently no-op'd before the fix — is exercised.
  const cli = path.resolve(fileURLToPath(import.meta.url), '..', '..', 'cli', 'inverita-guard.mjs');
  const { stdout, error } = probeDispatch(cli);
  assert.equal(error, null);
  assert.equal(JSON.parse(stdout).decision, 'block');
});
