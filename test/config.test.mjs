import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveMode, readProjectMode, DEFAULT_MODE } from '../src/config.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'guard-cfg-'));
}
function writeCfg(dir, obj) {
  fs.writeFileSync(path.join(dir, '.inverita-guard.json'), JSON.stringify(obj));
}

test('resolveMode: env var overrides everything (valid values only)', () => {
  const dir = tmp();
  writeCfg(dir, { mode: 'advisory' });
  assert.equal(resolveMode({ cwd: dir, env: { INVERITA_GUARD_MODE: 'enforce' } }), 'enforce');
  // case-insensitive
  assert.equal(resolveMode({ cwd: dir, env: { INVERITA_GUARD_MODE: 'ENFORCE' } }), 'enforce');
  // invalid env value is ignored → falls through to the project config
  assert.equal(resolveMode({ cwd: dir, env: { INVERITA_GUARD_MODE: 'bogus' } }), 'advisory');
});

test('resolveMode: default is advisory when nothing declares a mode', () => {
  assert.equal(resolveMode({ cwd: tmp(), env: {} }), DEFAULT_MODE);
  assert.equal(DEFAULT_MODE, 'advisory');
  // no args at all
  assert.equal(resolveMode(), 'advisory');
});

test('readProjectMode: explicit mode in the nearest config wins', () => {
  const dir = tmp();
  writeCfg(dir, { mode: 'enforce' });
  assert.equal(readProjectMode(dir), 'enforce');
});

test('readProjectMode: {healthcare:true} marker means enforce', () => {
  const dir = tmp();
  writeCfg(dir, { healthcare: true });
  assert.equal(readProjectMode(dir), 'enforce');
});

test('readProjectMode: walks up to a parent config', () => {
  const root = tmp();
  writeCfg(root, { mode: 'enforce' });
  const child = path.join(root, 'a', 'b');
  fs.mkdirSync(child, { recursive: true });
  assert.equal(readProjectMode(child), 'enforce');
});

test('readProjectMode: a config with no directive does not shadow a parent', () => {
  const root = tmp();
  writeCfg(root, { mode: 'enforce' });
  const child = path.join(root, 'sub');
  fs.mkdirSync(child, { recursive: true });
  writeCfg(child, { note: 'no mode here' }); // present but no directive → keep walking
  assert.equal(readProjectMode(child), 'enforce');
});

test('readProjectMode: invalid JSON is skipped, search continues upward', () => {
  const root = tmp();
  writeCfg(root, { mode: 'enforce' });
  const child = path.join(root, 'sub');
  fs.mkdirSync(child, { recursive: true });
  fs.writeFileSync(path.join(child, '.inverita-guard.json'), '{ not valid json');
  assert.equal(readProjectMode(child), 'enforce');
});

test('readProjectMode: null when no config anywhere up to the root', () => {
  // A fresh temp dir has no config; walking up to / finds none.
  assert.equal(readProjectMode(tmp()), null);
});

test('readProjectMode: null for a non-string cwd', () => {
  assert.equal(readProjectMode(undefined), null);
  assert.equal(readProjectMode(''), null);
  assert.equal(readProjectMode(42), null);
});

test('the shipped examples/.inverita-guard.json marker resolves to enforce', () => {
  // Guards the documented template against drift (comments + a valid directive).
  const examplesDir = path.resolve(HERE, '..', 'examples');
  assert.equal(readProjectMode(examplesDir), 'enforce');
});
