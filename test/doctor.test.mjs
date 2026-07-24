import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runDoctor, whichInveritaGuard, hookWiredIn } from '../src/doctor.mjs';

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'guard-doctor-'));
}

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
    assert.equal(res.checks.length, 4);
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
  });
  assert.equal(res.ok, true);
  assert.equal(res.checks.length, 4);
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
