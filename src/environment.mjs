/**
 * inverita-guardrail :: environment awareness
 * -------------------------------------------
 * Decides what a prompt is ABOUT — a developer's local machine, or a shared
 * dev/stage/prod system — so the guard can scale Layer-2 strictness to the
 * real-PHI risk of the work being discussed.
 *
 * This is orthogonal to `mode` (src/config.mjs). `mode` is how strict this
 * PROJECT wants to be; `environment` is what THIS PROMPT is about. They
 * compose in decideAction() (hooks/pre-prompt-guard.mjs):
 *
 *     Layer 1 (identifiers)  -> block, in every environment, always.
 *     Layer 2 + local        -> warn  (even under enforce mode)
 *     Layer 2 + dev/unknown  -> mode decides (today's behavior, unchanged)
 *     Layer 2 + stage/prod   -> block (even under advisory mode)
 *
 * Design notes:
 *  - Node stdlib only, deterministic, offline. Same constraints as the hook.
 *  - The marker tables are the tuning surface, the way LAYER2 is for detection.
 *    They are STACK-NEUTRAL by construction: one table entry per ecosystem plus
 *    a shared generic set. Supporting another language is a new entry, not a
 *    regex rewrite. Every entry carries a `stack` and a human-readable `marker`
 *    so an audit record can say WHY an environment was chosen.
 *  - Safety asymmetry, deliberate: escalation is cheap, relaxation is not.
 *    Prod/stage markers are checked first and win whenever both appear, and
 *    repo heuristics may only ever conclude 'local' — a branch or a file on
 *    disk is never allowed to start blocking prompts on its own.
 *  - Relaxing on prompt text IS a bypass: writing "localhost" softens Layer 2.
 *    That is an accepted, bounded trade — Layer 1 never yields, and Layer 2
 *    already defaults to advisory. Layer 1 is what keeps a real SSN out.
 */

import fs from 'node:fs';
import path from 'node:path';
import { findProjectConfig } from './config.mjs';

/** The declared environments, ordered from least to most sensitive. */
export const ENVIRONMENTS = ['local', 'dev', 'stage', 'prod'];

/** No signal fired — behave exactly as the guard did before this feature. */
export const UNKNOWN = 'unknown';

/** Layer 2 warns instead of blocking here. */
const RELAXED = new Set(['local']);

/** Layer 2 blocks here regardless of project mode. */
const STRICT = new Set(['stage', 'prod']);

export function isRelaxed(environment) {
  return RELAXED.has(environment);
}

export function isStrict(environment) {
  return STRICT.has(environment);
}

const ALIASES = new Map([
  ['local', 'local'],
  ['localhost', 'local'],
  ['dev', 'dev'],
  ['development', 'dev'],
  ['stage', 'stage'],
  ['staging', 'stage'],
  ['prod', 'prod'],
  ['production', 'prod'],
]);

/** Normalize a user-supplied environment name, or null if unrecognized. */
export function normalizeEnvironment(value) {
  if (typeof value !== 'string') return null;
  return ALIASES.get(value.trim().toLowerCase()) || null;
}

/* ------------------------------------------------------------------ *
 * Marker tables
 * ------------------------------------------------------------------ */

/**
 * Escalating markers, checked in order — first match wins. Stack-specific
 * entries come before generic ones purely so the audit record names the most
 * informative marker; they resolve to the same environment either way.
 *
 * `pre-prod` is deliberately first: it contains the substring "prod" and must
 * land on 'stage', not 'prod'.
 */
const STRICT_MARKERS = [
  { stack: 'generic', environment: 'stage', marker: 'pre-prod', re: /\bpre-?prod(?:uction)?\b/i },

  { stack: 'node', environment: 'prod', marker: 'NODE_ENV=production', re: /\bNODE_ENV\s*=\s*production\b/i },
  { stack: 'dotnet', environment: 'prod', marker: 'appsettings.Production.json', re: /appsettings\.Production\.json/i },
  { stack: 'dotnet', environment: 'prod', marker: 'ASPNETCORE_ENVIRONMENT=Production', re: /ASPNETCORE_ENVIRONMENT\s*=\s*Production\b/i },
  { stack: 'jvm', environment: 'prod', marker: 'spring profile prod', re: /spring\.profiles\.active\s*=\s*prod\b/i },
  { stack: 'jvm', environment: 'prod', marker: 'application-prod config', re: /application-prod\.(?:ya?ml|properties)\b/i },
  { stack: 'ruby', environment: 'prod', marker: 'RAILS_ENV=production', re: /RAILS_ENV\s*=\s*production\b/i },
  { stack: 'php', environment: 'prod', marker: 'APP_ENV=production', re: /APP_ENV\s*=\s*production\b/i },
  { stack: 'python', environment: 'prod', marker: 'FLASK_ENV=production', re: /FLASK_ENV\s*=\s*production\b/i },
  { stack: 'go', environment: 'prod', marker: 'GIN_MODE=release', re: /GIN_MODE\s*=\s*release\b/i },

  { stack: 'cloud', environment: 'prod', marker: 'prod namespace', re: /-n\s+prod\b/i },
  { stack: 'cloud', environment: 'prod', marker: 'prod- hostname', re: /\bprod-[a-z0-9]/i },
  { stack: 'cloud', environment: 'prod', marker: '.prod. hostname', re: /\.prod\./i },

  { stack: 'generic', environment: 'prod', marker: 'production', re: /\bproduction\b/i },
  // Bare "prod" needs an infrastructure companion word, so "prod the reviewer
  // for an answer" does not start blocking prompts.
  {
    stack: 'generic',
    environment: 'prod',
    marker: 'prod <resource>',
    re: /\bprod\b[\s_-]*(?:db|database|env|environment|server|cluster|data|deploy(?:ment)?|release|slot|instance|api|endpoint|box|node|pod|bucket|queue)\b/i,
  },
  { stack: 'generic', environment: 'prod', marker: 'live system', re: /\blive\s+(?:data|system|db|database|traffic|site|environment|users?)\b/i },
  { stack: 'generic', environment: 'prod', marker: 'real people', re: /\breal\s+(?:patient|customer|user|member|client)s?\b/i },

  { stack: 'generic', environment: 'stage', marker: 'staging', re: /\bstaging\b/i },
  { stack: 'generic', environment: 'stage', marker: 'stage <resource>', re: /\bstage\s+(?:env|environment|server|db|database|cluster|slot|box)\b/i },
  { stack: 'generic', environment: 'stage', marker: 'UAT', re: /\buat\b/i },
];

/**
 * Relaxing markers. Only consulted when no STRICT_MARKERS entry matched.
 * Adding an ecosystem means adding entries here — nothing else changes.
 */
const LOCAL_MARKERS = [
  { stack: 'generic', marker: 'localhost', re: /\blocalhost\b/i },
  { stack: 'generic', marker: 'loopback address', re: /\b(?:127\.0\.0\.1|0\.0\.0\.0)\b|\[::1\]/ },
  { stack: 'generic', marker: 'local dev', re: /\blocal\s+(?:dev|development|machine|environment|env|setup|run|db|database|copy)\b/i },
  { stack: 'generic', marker: 'my machine', re: /\bmy\s+(?:machine|laptop|box|workstation)\b/i },
  { stack: 'generic', marker: 'seed data', re: /\bseed(?:s|ed|ing)?\s+(?:data|script|fixture|file|db|database|table|rows?)\b/i },
  { stack: 'generic', marker: 'test double / sample data', re: /\b(?:fixtures?|mocks?|stubs?|dummy data|sample data|test data|synthetic data)\b/i },
  { stack: 'generic', marker: 'test suite', re: /\b(?:unit|integration|e2e)\s+tests?\b/i },
  { stack: 'generic', marker: 'sandbox', re: /\b(?:sandbox|scratch)\b/i },

  { stack: 'node', marker: 'package script', re: /\b(?:npm|yarn|pnpm)\s+(?:run\s+)?(?:dev|start:dev|test)\b/i },
  { stack: 'node', marker: 'dev tooling', re: /\b(?:nodemon|vite|webpack-dev-server)\b/i },
  { stack: 'node', marker: '.env.local', re: /\.env\.local\b/i },
  { stack: 'node', marker: 'test runner', re: /\b(?:jest|vitest|mocha)\b/i },
  { stack: 'node', marker: 'fake data lib', re: /\b(?:faker|msw)\b/i },

  { stack: 'dotnet', marker: 'dotnet CLI', re: /\bdotnet\s+(?:run|watch|test|user-secrets|ef)\b/i },
  { stack: 'dotnet', marker: 'launchSettings.json', re: /launchSettings\.json/i },
  { stack: 'dotnet', marker: 'appsettings.Development.json', re: /appsettings\.Development\.json/i },
  { stack: 'dotnet', marker: 'ASPNETCORE_ENVIRONMENT=Development', re: /ASPNETCORE_ENVIRONMENT\s*=\s*Development\b/i },
  { stack: 'dotnet', marker: 'test attribute', re: /\[(?:Fact|Theory|Test|TestMethod|SetUp)\]/ },
  { stack: 'dotnet', marker: 'InlineData', re: /\bInlineData\b/ },
  { stack: 'dotnet', marker: 'test/fake library', re: /\b(?:Moq|NSubstitute|FluentAssertions|AutoFixture|Bogus)\b/ },
  { stack: 'dotnet', marker: 'in-memory EF provider', re: /\bUseInMemoryDatabase\b|\bHasData\s*\(/ },
  { stack: 'dotnet', marker: 'IIS Express', re: /\bIIS\s*Express\b/i },

  { stack: 'python', marker: 'manage.py runserver', re: /\bmanage\.py\s+runserver\b/i },
  { stack: 'python', marker: 'pytest', re: /\b(?:pytest|conftest\.py)\b/i },
  { stack: 'python', marker: 'DEBUG=True', re: /\bDEBUG\s*=\s*True\b/ },
  { stack: 'python', marker: 'FLASK_ENV=development', re: /FLASK_ENV\s*=\s*development\b/i },
  { stack: 'python', marker: 'local interpreter', re: /\b(?:venv|virtualenv|tox|factory_boy)\b/i },

  { stack: 'jvm', marker: 'spring profile local/dev', re: /spring\.profiles\.active\s*=\s*(?:local|dev|test)\b/i },
  { stack: 'jvm', marker: 'application-local config', re: /application-(?:local|dev)\.(?:ya?ml|properties)\b/i },
  { stack: 'jvm', marker: 'gradle/maven run', re: /\bgradlew?\s+bootRun\b|\b(?:mvn|gradle)\s+test\b/i },
  { stack: 'jvm', marker: 'test library', re: /@SpringBootTest\b|\b(?:Mockito|testcontainers|H2)\b/i },

  { stack: 'go', marker: 'go run/test', re: /\bgo\s+(?:run|test)\b/i },
  { stack: 'go', marker: 'httptest', re: /\bhttptest\b/i },
  { stack: 'go', marker: 'GIN_MODE=debug', re: /GIN_MODE\s*=\s*debug\b/i },

  { stack: 'ruby', marker: 'rails server', re: /\brails\s+s(?:erver)?\b/i },
  { stack: 'ruby', marker: 'RAILS_ENV=development', re: /RAILS_ENV\s*=\s*development\b/i },
  { stack: 'ruby', marker: 'test library', re: /\b(?:rspec|FactoryBot)\b/i },

  { stack: 'php', marker: 'artisan serve', re: /\bphp\s+artisan\s+serve\b/i },
  { stack: 'php', marker: 'APP_ENV=local', re: /APP_ENV\s*=\s*local\b/i },
  { stack: 'php', marker: 'phpunit', re: /\bphpunit\b/i },

  { stack: 'rust', marker: 'cargo run/test', re: /\bcargo\s+(?:run|test)\b/i },

  { stack: 'container', marker: 'docker compose', re: /\bdocker[- ]compose\b/i },
  { stack: 'container', marker: 'local cluster', re: /\b(?:minikube|localstack)\b|\bkind\s+cluster\b/i },
];

/**
 * Classify a prompt from its text alone. Returns
 * { environment, stack, marker } or null when nothing fires.
 * Escalating markers are checked first, so a prompt mentioning both prod and
 * localhost resolves to prod.
 */
export function detectPromptEnvironment(prompt) {
  const text = typeof prompt === 'string' ? prompt : '';
  if (!text) return null;
  for (const m of STRICT_MARKERS) {
    if (m.re.test(text)) return { environment: m.environment, stack: m.stack, marker: m.marker };
  }
  for (const m of LOCAL_MARKERS) {
    if (m.re.test(text)) return { environment: 'local', stack: m.stack, marker: m.marker };
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Repo heuristics — dev-only artifacts, and local-only by construction
 * ------------------------------------------------------------------ *
 * Deliberately NOT a list of "is this a checkout" files. A package.json or a
 * .sln says a developer works here; it says nothing about whether THIS prompt
 * concerns prod. Relaxing on that would make almost every repo permanently
 * 'local' and quietly gut enforce mode. Only artifacts that exist solely to
 * run something locally count.
 */
const DEV_ONLY_ARTIFACTS = [
  '.env.local',
  '.env.development',
  'appsettings.Development.json',
  path.join('Properties', 'launchSettings.json'),
  'launchSettings.json',
  'application-local.yml',
  'application-local.yaml',
  'application-dev.yml',
  'docker-compose.yml',
  'docker-compose.yaml',
  'docker-compose.override.yml',
  'compose.yml',
  'compose.yaml',
  'Procfile.dev',
];

/**
 * Look for a dev-only artifact in `cwd`. Returns { environment: 'local',
 * marker } or null. Can never return anything but 'local'.
 */
export function sniffRepoEnvironment(cwd) {
  if (typeof cwd !== 'string' || !cwd) return null;
  let dir;
  try {
    dir = path.resolve(cwd);
  } catch {
    return null;
  }
  for (const artifact of DEV_ONLY_ARTIFACTS) {
    try {
      if (fs.statSync(path.join(dir, artifact)).isFile()) {
        return { environment: 'local', stack: 'repo', marker: artifact };
      }
    } catch {
      /* not here — keep looking */
    }
  }
  return null;
}

/** The nearest `.inverita-guard.json` declaring an `environment`, or null. */
export function readProjectEnvironment(cwd) {
  return findProjectConfig(cwd, (cfg) => normalizeEnvironment(cfg.environment));
}

/**
 * Resolve the effective environment. Precedence (highest first):
 *   1. INVERITA_GUARD_ENV        — org pin via managed settings
 *   2. .inverita-guard.json      — committed, reviewable project declaration
 *   3. prompt text               — automatic, what this message is about
 *   4. dev-only repo artifacts   — automatic, may only say 'local'
 *   5. UNKNOWN                   — behave exactly as before this feature
 *
 * Returns { environment, source, marker } where `source` is one of
 * 'env' | 'config' | 'prompt' | 'repo' | 'default'. `marker` is present for
 * the automatic sources so the audit log can explain the decision.
 */
export function resolveEnvironment({ cwd, env, prompt } = {}) {
  const pinned = normalizeEnvironment(env?.INVERITA_GUARD_ENV);
  if (pinned) return { environment: pinned, source: 'env' };

  const configured = readProjectEnvironment(cwd);
  if (configured) return { environment: configured, source: 'config' };

  const fromPrompt = detectPromptEnvironment(prompt);
  if (fromPrompt) {
    return { environment: fromPrompt.environment, source: 'prompt', marker: fromPrompt.marker };
  }

  const fromRepo = sniffRepoEnvironment(cwd);
  if (fromRepo) return { environment: fromRepo.environment, source: 'repo', marker: fromRepo.marker };

  return { environment: UNKNOWN, source: 'default' };
}
