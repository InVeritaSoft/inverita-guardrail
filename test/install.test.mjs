import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildManagedSettings,
  mergeHookIntoSettings,
  installToUserSettings,
} from '../src/install.mjs';

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-install-'));
  return path.join(dir, 'settings.json');
}

test('buildManagedSettings enforces the hook without the MCP-breaking lockdown flag', () => {
  const m = buildManagedSettings();
  assert.equal(m.allowManagedHooksOnly, true);
  assert.equal(m.hooks.UserPromptSubmit[0].hooks[0].command, 'inverita-guard');
  // strictPluginOnlyCustomization would also disable user/project MCP servers,
  // skills, and agents — it must NOT be part of the default enforcement.
  assert.equal('strictPluginOnlyCustomization' in m, false);
});

test('mergeHookIntoSettings preserves unrelated keys and is idempotent', () => {
  const base = { model: 'opus', hooks: { UserPromptSubmit: [] } };
  const first = mergeHookIntoSettings(base);
  assert.equal(first.already, false);
  assert.equal(first.settings.model, 'opus');
  assert.equal(first.settings.hooks.UserPromptSubmit.length, 1);
  const second = mergeHookIntoSettings(first.settings);
  assert.equal(second.already, true);
  assert.equal(second.settings.hooks.UserPromptSubmit.length, 1);
});

test('installToUserSettings writes then is idempotent', () => {
  const file = tmpFile();
  const r1 = installToUserSettings(file);
  assert.equal(r1.written, true);
  assert.equal(r1.already, false);
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(onDisk.hooks.UserPromptSubmit[0].hooks[0].command, 'inverita-guard');
  const r2 = installToUserSettings(file);
  assert.equal(r2.already, true);
});
