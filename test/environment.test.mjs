import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ENVIRONMENTS,
  UNKNOWN,
  detectPromptEnvironment,
  sniffRepoEnvironment,
  resolveEnvironment,
  isRelaxed,
  isStrict,
} from '../src/environment.mjs';

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'inv-guard-env-'));
}

/* ---------------- prompt detection: universal, per stack ---------------- */

const LOCAL_PROMPTS = [
  ['generic', 'point it at localhost:8080 and retry'],
  ['generic', 'write a seed fixture for the patient table'],
  ['node', 'npm run dev keeps crashing on boot'],
  ['dotnet', 'dotnet watch run fails to pick up launchSettings.json'],
  ['dotnet', 'add a [Theory] with InlineData for the mapper'],
  ['dotnet', 'set ASPNETCORE_ENVIRONMENT=Development before launching'],
  ['python', 'python manage.py runserver throws on migrate'],
  ['python', 'add a pytest conftest.py fixture'],
  ['jvm', 'spring.profiles.active=local is being ignored'],
  ['jvm', 'gradlew bootRun cannot find the H2 datasource'],
  ['go', 'go test ./... fails in the httptest handler'],
  ['ruby', 'rails s dies with RAILS_ENV=development'],
  ['php', 'php artisan serve with APP_ENV=local'],
  ['rust', 'cargo run panics on startup'],
  ['container', 'docker compose up brings the stack halfway'],
];

for (const [stack, prompt] of LOCAL_PROMPTS) {
  test(`prompt detection: local (${stack})`, () => {
    const hit = detectPromptEnvironment(prompt);
    assert.ok(hit, `expected a marker hit for: ${prompt}`);
    assert.equal(hit.environment, 'local');
  });
}

const PROD_PROMPTS = [
  ['generic', 'query the production patient database'],
  ['generic', 'this is live data from the prod cluster'],
  ['node', 'NODE_ENV=production breaks the build'],
  ['dotnet', 'appsettings.Production.json is missing a key'],
  ['dotnet', 'ASPNETCORE_ENVIRONMENT=Production on the slot'],
  ['jvm', 'spring.profiles.active=prod on the release box'],
  ['ruby', 'RAILS_ENV=production migration rollback'],
  ['go', 'GIN_MODE=release on the prod endpoint'],
  ['cloud', 'kubectl get pods -n prod shows crashloop'],
];

for (const [stack, prompt] of PROD_PROMPTS) {
  test(`prompt detection: prod (${stack})`, () => {
    const hit = detectPromptEnvironment(prompt);
    assert.ok(hit, `expected a marker hit for: ${prompt}`);
    assert.equal(hit.environment, 'prod');
  });
}

test('prompt detection: staging resolves to stage', () => {
  assert.equal(detectPromptEnvironment('deploy this to staging first').environment, 'stage');
  assert.equal(detectPromptEnvironment('the UAT box is out of date').environment, 'stage');
});

test('prompt detection: prod beats local when both appear', () => {
  const hit = detectPromptEnvironment('copy the prod database down to my localhost seed script');
  assert.equal(hit.environment, 'prod');
});

test('prompt detection: stage beats local when both appear', () => {
  const hit = detectPromptEnvironment('run the staging migration against localhost first');
  assert.equal(hit.environment, 'stage');
});

test('prompt detection: no signal returns null', () => {
  assert.equal(detectPromptEnvironment('rename this function to something clearer'), null);
  assert.equal(detectPromptEnvironment(''), null);
  assert.equal(detectPromptEnvironment(undefined), null);
});

test('prompt detection: "product" does not read as production', () => {
  assert.equal(detectPromptEnvironment('update the product roadmap copy'), null);
});

test('prompt detection: bare "prod" needs an infra companion word', () => {
  assert.equal(detectPromptEnvironment('prod the reviewer for an answer'), null);
  assert.equal(detectPromptEnvironment('the prod database is locked').environment, 'prod');
});

test('prompt detection: reports the marker and stack for auditability', () => {
  const hit = detectPromptEnvironment('dotnet watch run is stuck');
  assert.equal(hit.stack, 'dotnet');
  assert.equal(typeof hit.marker, 'string');
  assert.ok(hit.marker.length > 0);
});

/* ---------------- repo heuristics: dev-only artifacts, local-only ---------------- */

test('repo sniff: dev-only artifact yields local', () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, '.env.local'), '');
  const hit = sniffRepoEnvironment(dir);
  assert.equal(hit.environment, 'local');
  assert.equal(hit.marker, '.env.local');
});

test('repo sniff: dotnet dev artifacts yield local', () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, 'appsettings.Development.json'), '{}');
  assert.equal(sniffRepoEnvironment(dir).environment, 'local');

  const dir2 = tmpdir();
  fs.mkdirSync(path.join(dir2, 'Properties'));
  fs.writeFileSync(path.join(dir2, 'Properties', 'launchSettings.json'), '{}');
  assert.equal(sniffRepoEnvironment(dir2).environment, 'local');
});

test('repo sniff: merely being a checkout is NOT evidence', () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, 'package.json'), '{}');
  fs.writeFileSync(path.join(dir, 'App.sln'), '');
  fs.writeFileSync(path.join(dir, 'go.mod'), '');
  assert.equal(sniffRepoEnvironment(dir), null);
});

test('repo sniff: never escalates', () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, 'appsettings.Production.json'), '{}');
  const hit = sniffRepoEnvironment(dir);
  assert.ok(hit === null || hit.environment === 'local', 'repo heuristics may only ever say local');
});

/* ---------------- resolution precedence ---------------- */

test('resolve: env var wins over everything', () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, '.inverita-guard.json'), JSON.stringify({ environment: 'local' }));
  const r = resolveEnvironment({
    cwd: dir,
    env: { INVERITA_GUARD_ENV: 'prod' },
    prompt: 'seed my localhost fixture',
  });
  assert.equal(r.environment, 'prod');
  assert.equal(r.source, 'env');
});

test('resolve: project config beats prompt text', () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, '.inverita-guard.json'), JSON.stringify({ environment: 'prod' }));
  const r = resolveEnvironment({ cwd: dir, env: {}, prompt: 'just on localhost' });
  assert.equal(r.environment, 'prod');
  assert.equal(r.source, 'config');
});

test('resolve: config walks up the tree', () => {
  const root = tmpdir();
  fs.writeFileSync(path.join(root, '.inverita-guard.json'), JSON.stringify({ environment: 'stage' }));
  const nested = path.join(root, 'a', 'b');
  fs.mkdirSync(nested, { recursive: true });
  assert.equal(resolveEnvironment({ cwd: nested, env: {}, prompt: '' }).environment, 'stage');
});

test('resolve: prompt text beats repo heuristics', () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, '.env.local'), '');
  const r = resolveEnvironment({ cwd: dir, env: {}, prompt: 'against the prod database' });
  assert.equal(r.environment, 'prod');
  assert.equal(r.source, 'prompt');
});

test('resolve: repo heuristics apply only when the prompt is neutral', () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, '.env.local'), '');
  const r = resolveEnvironment({ cwd: dir, env: {}, prompt: 'rename this variable' });
  assert.equal(r.environment, 'local');
  assert.equal(r.source, 'repo');
});

test('resolve: no signal at all is unknown', () => {
  const dir = tmpdir();
  const r = resolveEnvironment({ cwd: dir, env: {}, prompt: 'rename this variable' });
  assert.equal(r.environment, UNKNOWN);
  assert.equal(r.source, 'default');
});

test('resolve: invalid env var / config values are ignored, not fatal', () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, '.inverita-guard.json'), JSON.stringify({ environment: 'banana' }));
  const r = resolveEnvironment({ cwd: dir, env: { INVERITA_GUARD_ENV: 'nonsense' }, prompt: '' });
  assert.equal(r.environment, UNKNOWN);
});

test('resolve: aliases normalize', () => {
  const at = (v) =>
    resolveEnvironment({ cwd: '', env: { INVERITA_GUARD_ENV: v }, prompt: '' }).environment;
  assert.equal(at('production'), 'prod');
  assert.equal(at('staging'), 'stage');
  assert.equal(at('development'), 'dev');
  assert.equal(at('LOCAL'), 'local');
});

/* ---------------- strictness classification ---------------- */

test('strictness: local relaxes, stage/prod tighten, dev/unknown neutral', () => {
  assert.ok(isRelaxed('local'));
  assert.ok(!isRelaxed('dev'));
  assert.ok(isStrict('stage'));
  assert.ok(isStrict('prod'));
  assert.ok(!isStrict('dev'));
  assert.ok(!isStrict(UNKNOWN));
  assert.ok(!isRelaxed(UNKNOWN));
});

test('ENVIRONMENTS is the declared set', () => {
  assert.deepEqual(ENVIRONMENTS, ['local', 'dev', 'stage', 'prod']);
});
