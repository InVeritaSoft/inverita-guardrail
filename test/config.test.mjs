import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  resolveMode,
  readProjectMode,
  DEFAULT_MODE,
  readProjectExceptions,
  resolveExceptionCategories,
  addProjectException,
  removeProjectException,
} from '../src/config.mjs';

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

test('readProjectExceptions: valid Layer-2 entries are returned with their reason', () => {
  const dir = tmp();
  writeCfg(dir, { exceptions: [{ category: 'medication_dosage', reason: 'pharmacy app' }] });
  assert.deepEqual(readProjectExceptions(dir), [{ category: 'medication_dosage', reason: 'pharmacy app' }]);
});

test('readProjectExceptions: a Layer-1 category is dropped even if present in the file', () => {
  const dir = tmp();
  // Simulates a hand-edited or malicious config trying to except an identifier check.
  writeCfg(dir, {
    exceptions: [
      { category: 'ssn_pattern', reason: 'trust me' },
      { category: 'medication_dosage', reason: 'legit' },
    ],
  });
  assert.deepEqual(readProjectExceptions(dir), [{ category: 'medication_dosage', reason: 'legit' }]);
});

test('readProjectExceptions: an unknown category is dropped', () => {
  const dir = tmp();
  writeCfg(dir, { exceptions: [{ category: 'not_a_real_category', reason: 'x' }] });
  assert.deepEqual(readProjectExceptions(dir), []);
});

test('readProjectExceptions: a missing reason defaults to an empty string', () => {
  const dir = tmp();
  writeCfg(dir, { exceptions: [{ category: 'icd_code' }] });
  assert.deepEqual(readProjectExceptions(dir), [{ category: 'icd_code', reason: '' }]);
});

test('readProjectExceptions: non-object entries are dropped', () => {
  const dir = tmp();
  writeCfg(dir, { exceptions: ['medication_dosage', null, 42] });
  assert.deepEqual(readProjectExceptions(dir), []);
});

test('readProjectExceptions: a config with no exceptions key does not shadow a parent', () => {
  const root = tmp();
  writeCfg(root, { exceptions: [{ category: 'icd_code', reason: 'root' }] });
  const child = path.join(root, 'sub');
  fs.mkdirSync(child, { recursive: true });
  writeCfg(child, { mode: 'enforce' }); // present but no `exceptions` key
  assert.deepEqual(readProjectExceptions(child), [{ category: 'icd_code', reason: 'root' }]);
});

test('readProjectExceptions: null/empty for a non-string cwd or no config anywhere', () => {
  assert.deepEqual(readProjectExceptions(undefined), []);
  assert.deepEqual(readProjectExceptions(''), []);
  assert.deepEqual(readProjectExceptions(tmp()), []);
});

test('resolveExceptionCategories: returns a Set of the effective category ids', () => {
  const dir = tmp();
  writeCfg(dir, {
    exceptions: [
      { category: 'medication_dosage', reason: 'a' },
      { category: 'lab_value', reason: 'b' },
    ],
  });
  const set = resolveExceptionCategories({ cwd: dir });
  assert.ok(set instanceof Set);
  assert.deepEqual([...set].sort(), ['lab_value', 'medication_dosage']);
});

test('addProjectException: creates the config file and records category + reason', () => {
  const dir = tmp();
  addProjectException(dir, 'medication_dosage', 'pharmacy app: doses are the point');
  const written = JSON.parse(fs.readFileSync(path.join(dir, '.inverita-guard.json'), 'utf8'));
  assert.deepEqual(written.exceptions, [
    { category: 'medication_dosage', reason: 'pharmacy app: doses are the point' },
  ]);
});

test('addProjectException: preserves other existing keys in the config', () => {
  const dir = tmp();
  writeCfg(dir, { mode: 'enforce', _comment: 'keep me' });
  addProjectException(dir, 'icd_code', 'billing codes are expected here');
  const written = JSON.parse(fs.readFileSync(path.join(dir, '.inverita-guard.json'), 'utf8'));
  assert.equal(written.mode, 'enforce');
  assert.equal(written._comment, 'keep me');
  assert.equal(written.exceptions.length, 1);
});

test('addProjectException: replaces an existing exception for the same category', () => {
  const dir = tmp();
  addProjectException(dir, 'medication_dosage', 'first reason');
  addProjectException(dir, 'medication_dosage', 'updated reason');
  const written = JSON.parse(fs.readFileSync(path.join(dir, '.inverita-guard.json'), 'utf8'));
  assert.equal(written.exceptions.length, 1);
  assert.equal(written.exceptions[0].reason, 'updated reason');
});

test('addProjectException: throws for a Layer-1 category', () => {
  const dir = tmp();
  assert.throws(() => addProjectException(dir, 'ssn_pattern', 'trust me'), /never be excepted/);
  assert.equal(fs.existsSync(path.join(dir, '.inverita-guard.json')), false);
});

test('addProjectException: throws for an unknown category', () => {
  const dir = tmp();
  assert.throws(() => addProjectException(dir, 'not_a_real_category', 'x'), /Unknown category/);
});

test('addProjectException: throws when reason is missing or blank', () => {
  const dir = tmp();
  assert.throws(() => addProjectException(dir, 'icd_code', undefined), /reason is required/);
  assert.throws(() => addProjectException(dir, 'icd_code', '   '), /reason is required/);
});

test('removeProjectException: removes the entry and preserves other keys', () => {
  const dir = tmp();
  writeCfg(dir, {
    mode: 'enforce',
    exceptions: [
      { category: 'icd_code', reason: 'a' },
      { category: 'lab_value', reason: 'b' },
    ],
  });
  const { removed } = removeProjectException(dir, 'icd_code');
  assert.equal(removed, true);
  const written = JSON.parse(fs.readFileSync(path.join(dir, '.inverita-guard.json'), 'utf8'));
  assert.equal(written.mode, 'enforce');
  assert.deepEqual(written.exceptions, [{ category: 'lab_value', reason: 'b' }]);
});

test('removeProjectException: is a no-op when the category is not present', () => {
  const dir = tmp();
  writeCfg(dir, { exceptions: [{ category: 'icd_code', reason: 'a' }] });
  const { removed } = removeProjectException(dir, 'lab_value');
  assert.equal(removed, false);
  const written = JSON.parse(fs.readFileSync(path.join(dir, '.inverita-guard.json'), 'utf8'));
  assert.equal(written.exceptions.length, 1);
});

test('removeProjectException: is a no-op when no config file exists at all', () => {
  const dir = tmp();
  const { removed } = removeProjectException(dir, 'icd_code');
  assert.equal(removed, false);
  assert.equal(fs.existsSync(path.join(dir, '.inverita-guard.json')), false);
});

test('the shipped examples/.inverita-guard.json marker resolves to enforce', () => {
  // Guards the documented template against drift (comments + a valid directive).
  const examplesDir = path.resolve(HERE, '..', 'examples');
  assert.equal(readProjectMode(examplesDir), 'enforce');
});
