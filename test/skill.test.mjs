import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKILL = path.resolve(HERE, '..', 'skills', 'guard-selfheal', 'SKILL.md');

test('guard-selfheal SKILL.md has valid frontmatter (name + description)', () => {
  const src = fs.readFileSync(SKILL, 'utf8');
  const m = src.match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(m, 'SKILL.md must start with a YAML frontmatter block');
  const fm = m[1];
  assert.match(fm, /^name:\s*guard-selfheal\s*$/m, 'frontmatter must declare name: guard-selfheal');
  assert.match(fm, /^description:\s*\S/m, 'frontmatter must declare a non-empty description');
});

test('guard-selfheal never instructs unsafe actions on managed settings', () => {
  // Guard the safety invariants in the skill text itself so an edit that turns
  // it into something that could break Claude usage fails CI.
  const body = fs.readFileSync(SKILL, 'utf8');
  assert.match(body, /[Nn]ever (edit|touch|modify).*managed settings/);
  assert.match(body, /strictPluginOnlyCustomization/);
  assert.match(body, /[Bb]ack ?up/);
});

test('guard-selfheal never instructs excepting a Layer-1 category or hand-editing exceptions', () => {
  const body = fs.readFileSync(SKILL, 'utf8');
  assert.match(body, /never except|do not except|not except it/i);
  assert.match(body, /inverita-guard exceptions add/);
  assert.match(body, /never hand-edit/i);
});
