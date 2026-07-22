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
