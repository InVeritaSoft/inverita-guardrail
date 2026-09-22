import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The plugin is distributed two ways — as an npm package (package.json) and as
 * a marketplace plugin (.claude-plugin/*.json) — and the admin console keys off
 * the plugin manifest, not package.json. When they drift, a release is pushed,
 * the console reports the same version as before, and developers are never
 * offered the update. That happened: 0.1.11 and 0.1.12 shipped with the
 * manifests still reading 0.1.10.
 *
 * These tests make the three versions one fact instead of three.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const read = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));

const pkg = read('package.json');
const plugin = read('.claude-plugin/plugin.json');
const marketplace = read('.claude-plugin/marketplace.json');

test('plugin.json version matches package.json', () => {
  assert.equal(
    plugin.version,
    pkg.version,
    'bump .claude-plugin/plugin.json in the same commit as package.json, ' +
      'or the marketplace will keep serving the previous version',
  );
});

test('marketplace.json version matches package.json', () => {
  assert.equal(
    marketplace.metadata.version,
    pkg.version,
    'bump .claude-plugin/marketplace.json in the same commit as package.json',
  );
});

test('the plugin name is consistent across manifests', () => {
  assert.equal(plugin.name, pkg.name);
  assert.equal(marketplace.name, pkg.name);
  assert.equal(marketplace.plugins[0].name, pkg.name);
});

test('versions are plain semver (the console rejects anything else)', () => {
  for (const [label, v] of [
    ['package.json', pkg.version],
    ['plugin.json', plugin.version],
    ['marketplace.json', marketplace.metadata.version],
  ]) {
    assert.match(v, /^\d+\.\d+\.\d+$/, `${label} must be plain semver`);
  }
});

test('the marketplace entry points at a source that exists', () => {
  const src = marketplace.plugins[0].source;
  assert.ok(src, 'marketplace plugin entry needs a source');
  assert.ok(fs.existsSync(path.resolve(ROOT, src)), `source not found: ${src}`);
});

test('the hook manifest references a hook file that exists', () => {
  const hooks = read('hooks/hooks.json');
  const commands = hooks.hooks.UserPromptSubmit.flatMap((g) => g.hooks).map((h) => h.command);
  assert.ok(commands.length > 0, 'no UserPromptSubmit hook registered');
  for (const cmd of commands) {
    const m = cmd.match(/\$CLAUDE_PLUGIN_ROOT\/(\S+?)"/);
    assert.ok(m, `hook command should resolve via $CLAUDE_PLUGIN_ROOT: ${cmd}`);
    assert.ok(fs.existsSync(path.join(ROOT, m[1])), `hook file missing: ${m[1]}`);
  }
});

test('every path in package.json "files" exists (npm install would ship a broken tree)', () => {
  for (const entry of pkg.files) {
    assert.ok(fs.existsSync(path.join(ROOT, entry)), `package.json files[] missing: ${entry}`);
  }
});
