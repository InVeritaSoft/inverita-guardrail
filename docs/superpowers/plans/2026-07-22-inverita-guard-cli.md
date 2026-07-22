# inverita-guard CLI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Package the existing PHI guard as an `inverita-guard` binary (the name the managed-settings hook calls) with `check`, `doctor`, `serve`, and `install` subcommands.

**Architecture:** Approach A — thin `bin/` entry that dispatches subcommands, reusing the detectors already exported from `hooks/pre-prompt-guard.mjs`. The current `main()` is extracted into an exported `processHookInput()` so both the plugin hook path and the CLI's default mode share one code path. Subcommand logic lives in small focused modules under `src/`.

**Tech Stack:** Node.js ≥18, ESM, zero runtime dependencies. Tests use `node:test` + `node:assert/strict`, spawning via `node:child_process`.

## Global Constraints

- **Zero runtime dependencies.** Node stdlib only (`node:*`). No packages added to `dependencies`.
- **ESM** (`"type": "module"`); all files are `.mjs` or covered by that type.
- **Node ≥18** (`engines.node`), keep `"private": true` — distribution is `npm i -g github:...`, never a registry publish.
- **Guard stays fail-open.** The default guard mode must be byte-for-byte identical to today's `hooks/pre-prompt-guard.mjs` output for block / clean / fail-open. Do not change detection behavior.
- **Audit stays local, metadata-only.** No network egress anywhere.
- **Hook command name is exactly `inverita-guard`** everywhere it is referenced.

## File Structure

- `hooks/pre-prompt-guard.mjs` — MODIFY: extract `processHookInput()`, add `INVERITA_GUARD_LOG_DIR` audit override. Detectors unchanged. Direct-invocation block unchanged (plugin `hooks.json` keeps working).
- `bin/inverita-guard.mjs` — CREATE: CLI entry; argv dispatch; default = guard mode.
- `src/check.mjs` — CREATE: `runCheck(prompt)`.
- `src/doctor.mjs` — CREATE: `runDoctor(deps)` + helpers.
- `src/serve.mjs` — CREATE: `createServer()` / `startServer()`.
- `src/install.mjs` — CREATE: settings-merge + managed-artifact builders.
- `package.json` — MODIFY: add `bin` field.
- `test/hook-core.test.mjs` — CREATE: `processHookInput` + audit-override tests.
- `test/cli.test.mjs` — CREATE: bin dispatch, check, doctor, serve, install tests.
- `README.md` — MODIFY: CLI install, doctor, serve, enforcement-ceiling docs.

---

### Task 1: Extract `processHookInput()` and add audit-dir override

**Files:**
- Modify: `hooks/pre-prompt-guard.mjs`
- Test: `test/hook-core.test.mjs` (create)

**Interfaces:**
- Consumes: existing `detect`, `appendAudit`, module constants.
- Produces:
  - `processHookInput(raw: string) -> { stdout: string }` — parses the hook JSON, runs `detect`, writes a best-effort audit record on block, returns the exact decision JSON string to print. Never throws, never exits.
  - `appendAudit` now writes to `process.env.INVERITA_GUARD_LOG_DIR` when set, else `pluginRoot()/logs` (unchanged default).

- [ ] **Step 1: Write the failing test**

Create `test/hook-core.test.mjs`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { processHookInput, appendAudit } from '../hooks/pre-prompt-guard.mjs';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'guard-core-'));
}

test('processHookInput blocks a Layer 1 prompt', () => {
  const { stdout } = processHookInput(
    JSON.stringify({ prompt: 'patient SSN is 123-45-6789', session_id: 's' }),
  );
  const out = JSON.parse(stdout);
  assert.equal(out.decision, 'block');
  assert.match(out.reason, /category: ssn_pattern/);
});

test('processHookInput passes a clean prompt with additionalContext', () => {
  const { stdout } = processHookInput(
    JSON.stringify({ prompt: 'refactor the scheduler', session_id: 's' }),
  );
  const out = JSON.parse(stdout);
  assert.equal(out.decision, undefined);
  assert.equal(out.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.match(out.hookSpecificOutput.additionalContext, /healthcare-data project/i);
});

test('processHookInput fails open on malformed input', () => {
  const { stdout } = processHookInput('not json');
  const out = JSON.parse(stdout);
  assert.equal(out.decision, undefined);
  assert.match(out.hookSpecificOutput.additionalContext, /could not be read/i);
});

test('appendAudit honors INVERITA_GUARD_LOG_DIR override', () => {
  const dir = tmpDir();
  const prev = process.env.INVERITA_GUARD_LOG_DIR;
  process.env.INVERITA_GUARD_LOG_DIR = dir;
  try {
    appendAudit({ session_id: 's', tier: 1, category: 'ssn_pattern' }, '2026-07-22T00:00:00.000Z');
  } finally {
    if (prev === undefined) delete process.env.INVERITA_GUARD_LOG_DIR;
    else process.env.INVERITA_GUARD_LOG_DIR = prev;
  }
  const rec = JSON.parse(fs.readFileSync(path.join(dir, 'audit.jsonl'), 'utf8').trim());
  assert.equal(rec.category, 'ssn_pattern');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/hook-core.test.mjs`
Expected: FAIL — `processHookInput` is not exported (`SyntaxError: ... does not provide an export named 'processHookInput'`).

- [ ] **Step 3: Implement the extraction**

In `hooks/pre-prompt-guard.mjs`, change the audit dir line inside `appendAudit` from:

```javascript
    const dir = path.join(pluginRoot(), 'logs');
```

to:

```javascript
    const dir = process.env.INVERITA_GUARD_LOG_DIR || path.join(pluginRoot(), 'logs');
```

Then add this exported function just above the `Hook entry point` section:

```javascript
function contextOutput(context) {
  return {
    hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: context },
  };
}

/**
 * Decide on a raw stdin payload and return the exact decision JSON to print.
 * Never throws, never exits — fail-open by returning the FAILOPEN context.
 */
export function processHookInput(raw) {
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return { stdout: JSON.stringify(contextOutput(FAILOPEN_CONTEXT)) };
  }
  try {
    const prompt = typeof payload.prompt === 'string' ? payload.prompt : '';
    const sessionId =
      typeof payload.session_id === 'string' && payload.session_id ? payload.session_id : 'unknown';
    const hit = detect(prompt);
    if (hit) {
      appendAudit(
        { session_id: sessionId, tier: hit.tier, category: hit.category },
        new Date().toISOString(),
      );
      return { stdout: JSON.stringify({ decision: 'block', reason: hit.reason }) };
    }
    return { stdout: JSON.stringify(contextOutput(CLEAN_CONTEXT)) };
  } catch {
    return { stdout: JSON.stringify(contextOutput(FAILOPEN_CONTEXT)) };
  }
}
```

Then simplify `main()` to reuse it (replace the body of `main` with):

```javascript
async function main() {
  let raw = '';
  try {
    raw = await readStdin();
  } catch {
    /* fall through — processHookInput fails open on empty/unreadable input */
  }
  const { stdout } = processHookInput(raw);
  process.stdout.write(stdout);
  process.exit(0);
}
```

The now-unused `emit` / `emitContext` helpers may be removed; leave `readStdin` intact.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/hook-core.test.mjs`
Expected: PASS (4 tests).

- [ ] **Step 5: Verify no regression in the existing suite**

Run: `npm test`
Expected: PASS — all existing `test/guardrail.test.mjs` tests still green (the spawned-hook behavior is unchanged).

- [ ] **Step 6: Commit**

```bash
git add hooks/pre-prompt-guard.mjs test/hook-core.test.mjs
git commit -m "refactor: extract processHookInput() + add audit-dir override"
```

---

### Task 2: `bin/inverita-guard.mjs` default guard mode + `--version`/`--help`

**Files:**
- Create: `bin/inverita-guard.mjs`
- Modify: `package.json` (add `bin`)
- Test: `test/cli.test.mjs` (create)

**Interfaces:**
- Consumes: `processHookInput` from Task 1.
- Produces: executable `inverita-guard`. No subcommand + piped stdin → guard mode (prints decision JSON, exit 0). No subcommand + TTY → prints help, exit 0. `--version`/`--help` implemented. Unknown command → stderr + help, exit 2. The `check`/`doctor`/`serve`/`install` cases are added in later tasks.

- [ ] **Step 1: Write the failing test**

Create `test/cli.test.mjs`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.resolve(HERE, '..', 'bin', 'inverita-guard.mjs');

function run(args, input) {
  return spawnSync('node', [BIN, ...args], { input, encoding: 'utf8' });
}

test('default mode with piped stdin runs the guard and blocks PHI', () => {
  const res = run([], JSON.stringify({ prompt: 'patient SSN is 123-45-6789', session_id: 's' }));
  assert.equal(res.status, 0);
  const out = JSON.parse(res.stdout);
  assert.equal(out.decision, 'block');
  assert.match(out.reason, /category: ssn_pattern/);
});

test('default mode passes a clean prompt', () => {
  const res = run([], JSON.stringify({ prompt: 'refactor the scheduler', session_id: 's' }));
  assert.equal(res.status, 0);
  const out = JSON.parse(res.stdout);
  assert.equal(out.decision, undefined);
  assert.match(out.hookSpecificOutput.additionalContext, /healthcare-data project/i);
});

test('--version prints a semver and exits 0', () => {
  const res = run(['--version']);
  assert.equal(res.status, 0);
  assert.match(res.stdout.trim(), /^\d+\.\d+\.\d+$/);
});

test('--help lists the subcommands and exits 0', () => {
  const res = run(['--help']);
  assert.equal(res.status, 0);
  assert.match(res.stdout, /inverita-guard/);
  assert.match(res.stdout, /check/);
  assert.match(res.stdout, /doctor/);
});

test('unknown command exits 2', () => {
  const res = run(['wat']);
  assert.equal(res.status, 2);
  assert.match(res.stderr, /unknown command/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/cli.test.mjs`
Expected: FAIL — `bin/inverita-guard.mjs` does not exist (spawn returns non-zero / MODULE_NOT_FOUND).

- [ ] **Step 3: Create the bin**

Create `bin/inverita-guard.mjs`:

```javascript
#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import process from 'node:process';
import { processHookInput } from '../hooks/pre-prompt-guard.mjs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => {
      data += c;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
  });
}

function printHelp() {
  process.stdout.write(
    `inverita-guard ${pkg.version}\n\n` +
      `Usage:\n` +
      `  inverita-guard                 Guard mode: read hook JSON on stdin, print decision (exit 0)\n` +
      `  inverita-guard check <prompt>  Test the detector against a prompt\n` +
      `  inverita-guard doctor          Verify install + hook wiring (exit 0 if healthy)\n` +
      `  inverita-guard serve           Run the HTTP-hook endpoint\n` +
      `  inverita-guard install         Wire the hook into ~/.claude/settings.json\n` +
      `  inverita-guard --version\n` +
      `  inverita-guard --help\n`,
  );
}

async function guardMode() {
  const raw = await readStdin();
  const { stdout } = processHookInput(raw);
  process.stdout.write(stdout);
  process.exit(0);
}

const argv = process.argv.slice(2);
const cmd = argv[0];

if (cmd === undefined) {
  if (process.stdin.isTTY) {
    printHelp();
    process.exit(0);
  } else {
    await guardMode();
  }
} else if (cmd === '--version' || cmd === '-v') {
  process.stdout.write(`${pkg.version}\n`);
} else if (cmd === '--help' || cmd === '-h') {
  printHelp();
} else {
  process.stderr.write(`unknown command: ${cmd}\n`);
  printHelp();
  process.exit(2);
}
```

- [ ] **Step 4: Add the `bin` field to package.json**

In `package.json`, add this key (after `"description"`):

```json
  "bin": {
    "inverita-guard": "bin/inverita-guard.mjs"
  },
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test test/cli.test.mjs`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add bin/inverita-guard.mjs package.json test/cli.test.mjs
git commit -m "feat: inverita-guard bin with guard mode, --version, --help"
```

---

### Task 3: `check` subcommand

**Files:**
- Create: `src/check.mjs`
- Modify: `bin/inverita-guard.mjs`
- Test: `test/cli.test.mjs` (append)

**Interfaces:**
- Consumes: `detect` from `hooks/pre-prompt-guard.mjs`.
- Produces: `runCheck(prompt: string) -> { decision: 'block'|'clean', tier: number|null, category: string|null }`. Bin `check` prints human or `--json`, exit 1 on block else 0.

- [ ] **Step 1: Write the failing test**

Append to `test/cli.test.mjs`:

```javascript
test('check blocks PHI: exit 1 and reports category', () => {
  const res = run(['check', 'patient SSN is 123-45-6789']);
  assert.equal(res.status, 1);
  assert.match(res.stdout, /BLOCK/);
  assert.match(res.stdout, /ssn_pattern/);
});

test('check on a clean prompt: exit 0 and CLEAN', () => {
  const res = run(['check', 'refactor the scheduler']);
  assert.equal(res.status, 0);
  assert.match(res.stdout, /CLEAN/);
});

test('check --json emits a structured verdict', () => {
  const res = run(['check', '--json', 'prescribe 10mg twice daily']);
  assert.equal(res.status, 1);
  const out = JSON.parse(res.stdout);
  assert.equal(out.decision, 'block');
  assert.equal(out.tier, 2);
  assert.equal(out.category, 'medication_dosage');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/cli.test.mjs`
Expected: FAIL — `check` currently hits the unknown-command branch (exit 2, not 1).

- [ ] **Step 3: Create `src/check.mjs`**

```javascript
import { detect } from '../hooks/pre-prompt-guard.mjs';

export function runCheck(prompt) {
  const hit = detect(prompt);
  if (!hit) return { decision: 'clean', tier: null, category: null };
  return { decision: 'block', tier: hit.tier, category: hit.category };
}
```

- [ ] **Step 4: Wire `check` into the bin**

In `bin/inverita-guard.mjs`, add the import near the top (below the `processHookInput` import):

```javascript
import { runCheck } from '../src/check.mjs';
```

Then replace the `} else {` unknown-command branch with a `check` branch before it:

```javascript
} else if (cmd === 'check') {
  const rest = argv.slice(1);
  const json = rest.includes('--json');
  const promptArg = rest.filter((a) => a !== '--json')[0];
  let prompt = promptArg;
  if (prompt === undefined && !process.stdin.isTTY) prompt = await readStdin();
  const verdict = runCheck(prompt || '');
  if (json) {
    process.stdout.write(`${JSON.stringify(verdict)}\n`);
  } else if (verdict.decision === 'block') {
    process.stdout.write(`BLOCK  tier=${verdict.tier}  category=${verdict.category}\n`);
  } else {
    process.stdout.write('CLEAN\n');
  }
  process.exit(verdict.decision === 'block' ? 1 : 0);
} else {
  process.stderr.write(`unknown command: ${cmd}\n`);
  printHelp();
  process.exit(2);
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test test/cli.test.mjs`
Expected: PASS (8 tests total).

- [ ] **Step 6: Commit**

```bash
git add src/check.mjs bin/inverita-guard.mjs test/cli.test.mjs
git commit -m "feat: inverita-guard check subcommand"
```

---

### Task 4: `doctor` subcommand

**Files:**
- Create: `src/doctor.mjs`
- Modify: `bin/inverita-guard.mjs`
- Test: `test/cli.test.mjs` (append), `test/doctor.test.mjs` (create)

**Interfaces:**
- Consumes: `detect` from `hooks/pre-prompt-guard.mjs`.
- Produces:
  - `whichInveritaGuard(env, platform) -> string|null`
  - `hookWiredIn(settingsObj) -> boolean`
  - `runDoctor({ env, homedir, cwd, platform, nodeVersion }) -> { ok: boolean, checks: Array<{ name, ok, detail }> }`
  - Bin `doctor` prints the checks and exits `0` iff `ok`, else `1`. `--json` emits the result object.

- [ ] **Step 1: Write the failing unit test**

Create `test/doctor.test.mjs`:

```javascript
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/doctor.test.mjs`
Expected: FAIL — `src/doctor.mjs` does not exist.

- [ ] **Step 3: Create `src/doctor.mjs`**

```javascript
import fs from 'node:fs';
import path from 'node:path';
import { detect } from '../hooks/pre-prompt-guard.mjs';

export function whichInveritaGuard(env, platform) {
  const raw = env.PATH || env.Path || '';
  const sep = platform === 'win32' ? ';' : ':';
  const names =
    platform === 'win32'
      ? ['inverita-guard.cmd', 'inverita-guard.exe', 'inverita-guard']
      : ['inverita-guard'];
  for (const dir of raw.split(sep).filter(Boolean)) {
    for (const name of names) {
      const p = path.join(dir, name);
      try {
        if (fs.statSync(p).isFile()) return p;
      } catch {
        /* not here — keep looking */
      }
    }
  }
  return null;
}

export function hookWiredIn(settingsObj) {
  const ups = settingsObj?.hooks?.UserPromptSubmit;
  if (!Array.isArray(ups)) return false;
  return ups.some(
    (g) =>
      Array.isArray(g?.hooks) &&
      g.hooks.some((h) => typeof h?.command === 'string' && h.command.includes('inverita-guard')),
  );
}

function settingsSources(homedir, cwd, platform) {
  const managed =
    platform === 'darwin'
      ? '/Library/Application Support/ClaudeCode/managed-settings.json'
      : platform === 'win32'
        ? 'C:\\Program Files\\ClaudeCode\\managed-settings.json'
        : '/etc/claude-code/managed-settings.json';
  return [
    ['managed', managed],
    ['user', path.join(homedir, '.claude', 'settings.json')],
    ['project', path.join(cwd, '.claude', 'settings.json')],
  ];
}

export function runDoctor({ env, homedir, cwd, platform, nodeVersion }) {
  const checks = [];

  const major = parseInt(String(nodeVersion).replace(/^v/, '').split('.')[0], 10);
  checks.push({ name: 'node>=18', ok: major >= 18, detail: `node ${nodeVersion}` });

  const bin = whichInveritaGuard(env, platform);
  checks.push({ name: 'inverita-guard on PATH', ok: !!bin, detail: bin || 'not found on PATH' });

  let wired = null;
  for (const [source, file] of settingsSources(homedir, cwd, platform)) {
    try {
      const obj = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (hookWiredIn(obj)) {
        wired = `${source}: ${file}`;
        break;
      }
    } catch {
      /* unreadable/absent source — skip */
    }
  }
  checks.push({
    name: 'managed hook wired',
    ok: !!wired,
    detail: wired || 'no UserPromptSubmit hook referencing inverita-guard found',
  });

  const blocks = !!detect('patient SSN is 123-45-6789');
  const clean = detect('refactor the scheduler component') === null;
  checks.push({
    name: 'detector smoke test',
    ok: blocks && clean,
    detail: blocks && clean ? 'block+clean OK' : 'detector misbehaving',
  });

  return { ok: checks.every((c) => c.ok), checks };
}
```

- [ ] **Step 4: Run unit tests to verify they pass**

Run: `node --test test/doctor.test.mjs`
Expected: PASS (4 tests).

- [ ] **Step 5: Wire `doctor` into the bin**

In `bin/inverita-guard.mjs`, add imports near the top:

```javascript
import os from 'node:os';
import { runDoctor } from '../src/doctor.mjs';
```

Add a `doctor` branch before the final `} else {` unknown-command branch:

```javascript
} else if (cmd === 'doctor') {
  const json = argv.includes('--json');
  const result = runDoctor({
    env: process.env,
    homedir: os.homedir(),
    cwd: process.cwd(),
    platform: process.platform,
    nodeVersion: process.version,
  });
  if (json) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else {
    for (const c of result.checks) {
      process.stdout.write(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}  (${c.detail})\n`);
    }
    process.stdout.write(`\n${result.ok ? 'OK: guard is healthy' : 'PROBLEM: see FAIL lines above'}\n`);
  }
  process.exit(result.ok ? 0 : 1);
```

- [ ] **Step 6: Add a bin exit-code test**

Append to `test/cli.test.mjs`:

```javascript
test('doctor --json returns a result object and a nonzero exit when unwired', () => {
  const res = run(['doctor', '--json']);
  assert.ok(res.status === 0 || res.status === 1, 'doctor exits 0 or 1');
  const out = JSON.parse(res.stdout);
  assert.ok(Array.isArray(out.checks) && out.checks.length === 4);
  assert.equal(typeof out.ok, 'boolean');
});
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `node --test test/cli.test.mjs test/doctor.test.mjs`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/doctor.mjs bin/inverita-guard.mjs test/doctor.test.mjs test/cli.test.mjs
git commit -m "feat: inverita-guard doctor subcommand"
```

---

### Task 5: `serve` subcommand (HTTP-hook endpoint)

**Files:**
- Create: `src/serve.mjs`
- Modify: `bin/inverita-guard.mjs`
- Test: `test/serve.test.mjs` (create)

**Interfaces:**
- Consumes: `processHookInput` from `hooks/pre-prompt-guard.mjs`.
- Produces:
  - `createServer() -> http.Server` — `POST` any path → decision JSON (same as command hook); `GET /healthz` → `{status:'ok'}`; other methods → 405.
  - `startServer({ host, port }) -> http.Server` — listens and returns the server.
  - Bin `serve` prints a banner then listens; `--port`/`--host` override defaults (`127.0.0.1:8787`).

- [ ] **Step 1: Write the failing test**

Create `test/serve.test.mjs`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createServer } from '../src/serve.mjs';

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function request(port, method, path, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path }, (res) => {
      let data = '';
      res.on('data', (c) => {
        data += c;
      });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

test('POST with PHI returns a block decision', async () => {
  const server = createServer();
  const port = await listen(server);
  try {
    const res = await request(port, 'POST', '/', JSON.stringify({ prompt: 'patient SSN is 123-45-6789' }));
    assert.equal(res.status, 200);
    const out = JSON.parse(res.body);
    assert.equal(out.decision, 'block');
    assert.match(out.reason, /ssn_pattern/);
  } finally {
    server.close();
  }
});

test('POST with a clean prompt returns additionalContext', async () => {
  const server = createServer();
  const port = await listen(server);
  try {
    const res = await request(port, 'POST', '/', JSON.stringify({ prompt: 'refactor the scheduler' }));
    assert.equal(res.status, 200);
    const out = JSON.parse(res.body);
    assert.equal(out.decision, undefined);
    assert.ok(out.hookSpecificOutput.additionalContext);
  } finally {
    server.close();
  }
});

test('GET /healthz returns ok', async () => {
  const server = createServer();
  const port = await listen(server);
  try {
    const res = await request(port, 'GET', '/healthz');
    assert.equal(res.status, 200);
    assert.equal(JSON.parse(res.body).status, 'ok');
  } finally {
    server.close();
  }
});

test('non-POST/non-health returns 405', async () => {
  const server = createServer();
  const port = await listen(server);
  try {
    const res = await request(port, 'GET', '/');
    assert.equal(res.status, 405);
  } finally {
    server.close();
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/serve.test.mjs`
Expected: FAIL — `src/serve.mjs` does not exist.

- [ ] **Step 3: Create `src/serve.mjs`**

```javascript
import http from 'node:http';
import { processHookInput } from '../hooks/pre-prompt-guard.mjs';

export function createServer() {
  return http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'method not allowed' }));
      return;
    }
    let body = '';
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', () => {
      const { stdout } = processHookInput(body);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(stdout);
    });
    req.on('error', () => {
      res.writeHead(400);
      res.end();
    });
  });
}

export function startServer({ host = '127.0.0.1', port = 8787 } = {}) {
  const server = createServer();
  server.listen(port, host);
  return server;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/serve.test.mjs`
Expected: PASS (4 tests).

- [ ] **Step 5: Wire `serve` into the bin**

In `bin/inverita-guard.mjs`, add the import:

```javascript
import { startServer } from '../src/serve.mjs';
```

Add a `serve` branch before the final unknown-command `} else {`:

```javascript
} else if (cmd === 'serve') {
  const rest = argv.slice(1);
  const portIdx = rest.indexOf('--port');
  const hostIdx = rest.indexOf('--host');
  const port = portIdx >= 0 ? Number(rest[portIdx + 1]) : 8787;
  const host = hostIdx >= 0 ? rest[hostIdx + 1] : '127.0.0.1';
  process.stderr.write(
    `[inverita-guard] serving on http://${host}:${port}\n` +
      `WARNING: every prompt (possibly containing PHI) is POSTed here — run this\n` +
      `endpoint only inside your compliance boundary. Claude Code fails OPEN on\n` +
      `connection error/timeout.\n`,
  );
  startServer({ host, port });
```

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: PASS across all test files.

- [ ] **Step 7: Commit**

```bash
git add src/serve.mjs bin/inverita-guard.mjs test/serve.test.mjs
git commit -m "feat: inverita-guard serve (HTTP-hook endpoint)"
```

---

### Task 6: `install` subcommand

**Files:**
- Create: `src/install.mjs`
- Modify: `bin/inverita-guard.mjs`
- Test: `test/install.test.mjs` (create)

**Interfaces:**
- Produces:
  - `buildUserHookGroup() -> { hooks: [{ type:'command', command:'inverita-guard', timeout:10 }] }`
  - `buildManagedSettings() -> object` (hook + `allowManagedHooksOnly` + `strictPluginOnlyCustomization`)
  - `mergeHookIntoSettings(settings) -> { settings, already: boolean }`
  - `installToUserSettings(settingsPath) -> { written: boolean, already: boolean }`
  - Bin `install`: default writes `~/.claude/settings.json`; `--managed` prints managed artifact; `--print` previews without writing.

- [ ] **Step 1: Write the failing test**

Create `test/install.test.mjs`:

```javascript
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

test('buildManagedSettings has the hook and both enforcement flags', () => {
  const m = buildManagedSettings();
  assert.equal(m.allowManagedHooksOnly, true);
  assert.equal(m.strictPluginOnlyCustomization, true);
  assert.equal(m.hooks.UserPromptSubmit[0].hooks[0].command, 'inverita-guard');
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/install.test.mjs`
Expected: FAIL — `src/install.mjs` does not exist.

- [ ] **Step 3: Create `src/install.mjs`**

```javascript
import fs from 'node:fs';
import path from 'node:path';

export function buildUserHookGroup() {
  return { hooks: [{ type: 'command', command: 'inverita-guard', timeout: 10 }] };
}

export function buildManagedSettings() {
  return {
    hooks: { UserPromptSubmit: [buildUserHookGroup()] },
    allowManagedHooksOnly: true,
    strictPluginOnlyCustomization: true,
  };
}

export function mergeHookIntoSettings(settings) {
  const next = { ...settings };
  next.hooks = { ...(settings.hooks || {}) };
  const ups = Array.isArray(next.hooks.UserPromptSubmit) ? [...next.hooks.UserPromptSubmit] : [];
  const already = ups.some(
    (g) => Array.isArray(g?.hooks) && g.hooks.some((h) => h?.command === 'inverita-guard'),
  );
  if (!already) ups.push(buildUserHookGroup());
  next.hooks.UserPromptSubmit = ups;
  return { settings: next, already };
}

export function installToUserSettings(settingsPath) {
  let current = {};
  try {
    current = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  } catch {
    current = {};
  }
  const { settings, already } = mergeHookIntoSettings(current);
  if (already) return { written: false, already: true };
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  return { written: true, already: false };
}
```

- [ ] **Step 4: Run unit tests to verify they pass**

Run: `node --test test/install.test.mjs`
Expected: PASS (3 tests).

- [ ] **Step 5: Wire `install` into the bin**

In `bin/inverita-guard.mjs`, add the import:

```javascript
import { buildManagedSettings, installToUserSettings, mergeHookIntoSettings } from '../src/install.mjs';
import { readFileSync as readFileSyncForInstall } from 'node:fs';
```

Add an `install` branch before the final unknown-command `} else {`:

```javascript
} else if (cmd === 'install') {
  const rest = argv.slice(1);
  if (rest.includes('--managed')) {
    process.stdout.write(`${JSON.stringify(buildManagedSettings(), null, 2)}\n`);
  } else {
    const file = path.join(os.homedir(), '.claude', 'settings.json');
    if (rest.includes('--print')) {
      let current = {};
      try {
        current = JSON.parse(readFileSyncForInstall(file, 'utf8'));
      } catch {
        current = {};
      }
      process.stdout.write(`${JSON.stringify(mergeHookIntoSettings(current).settings, null, 2)}\n`);
    } else {
      const r = installToUserSettings(file);
      process.stdout.write(
        r.already
          ? `inverita-guard hook already present in ${file}\n`
          : `wired inverita-guard UserPromptSubmit hook into ${file}\n`,
      );
    }
  }
  process.exit(0);
```

Note: `path` and `os` are already imported (Tasks 2 and 4). If `path` is not yet imported in the bin, add `import path from 'node:path';` near the top.

- [ ] **Step 6: Add a bin-level install test**

Append to `test/cli.test.mjs`:

```javascript
test('install --managed prints valid managed settings JSON', () => {
  const res = run(['install', '--managed']);
  assert.equal(res.status, 0);
  const out = JSON.parse(res.stdout);
  assert.equal(out.allowManagedHooksOnly, true);
  assert.equal(out.hooks.UserPromptSubmit[0].hooks[0].command, 'inverita-guard');
});
```

- [ ] **Step 7: Run the full suite**

Run: `npm test`
Expected: PASS across all files.

- [ ] **Step 8: Commit**

```bash
git add src/install.mjs bin/inverita-guard.mjs test/install.test.mjs test/cli.test.mjs
git commit -m "feat: inverita-guard install subcommand"
```

---

### Task 7: Documentation

**Files:**
- Modify: `README.md`

**Interfaces:** none (docs only).

- [ ] **Step 1: Add a "CLI (inverita-guard)" section to README.md**

Insert after the "What it does" section:

````markdown
## CLI: `inverita-guard`

The guard ships as a binary named `inverita-guard` — the command the managed
hook invokes.

### Install (per machine)

```bash
npm i -g github:InVeritaSoft/inverita-guardrail
```

npm creates the per-OS PATH shim (`inverita-guard` on Unix,
`inverita-guard.cmd` on Windows). The guard then runs offline and instantly on
every prompt.

### Commands

| Command | Purpose |
|---------|---------|
| `inverita-guard` | Guard mode: reads the hook JSON on stdin, prints the block/allow decision (exit 0). What the managed hook calls. |
| `inverita-guard check "<prompt>"` | Test the detector against a prompt. Exit 1 if it would block. `--json` for machine output. |
| `inverita-guard doctor` | Verify Node ≥18, `inverita-guard` on PATH, the hook is wired, and a detector smoke test. Exit 0 iff healthy. `--json` for aggregation. |
| `inverita-guard serve [--host H] [--port N]` | Run the HTTP-hook endpoint (POST prompt → decision JSON, `GET /healthz`). |
| `inverita-guard install [--managed] [--print]` | Wire the hook into `~/.claude/settings.json`; `--managed` emits the org managed-settings artifact; `--print` previews. |

### Coverage detection (no MDM)

`inverita-guard doctor --json` is exit-code driven — run it over SSH/your fleet
tool to find machines where the guard isn't installed or wired. This is the
detection lever when you don't have device management to guarantee the binary.

### HTTP-hook variant

`inverita-guard serve` exposes the same detector over HTTP for the zero-endpoint
deployment. **Warning:** every prompt (possibly containing PHI) is POSTed to the
endpoint — run it only inside your compliance boundary, over TLS, and don't log
prompt bodies. Claude Code fails **open** on connection error/timeout.
````

- [ ] **Step 2: Verify the full suite still passes**

Run: `npm test`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: document the inverita-guard CLI and coverage detection"
```

---

## Self-Review

**Spec coverage:**
- Default guard mode (byte-identical, fail-open) → Task 1 + Task 2. ✅
- `check` → Task 3. ✅
- `doctor` (+ coverage detection) → Task 4 + Task 7. ✅
- `serve` (HTTP hook + egress warning) → Task 5 + Task 7. ✅
- `install` (user default, `--managed`, `--print`) → Task 6. ✅
- Approach A structure (`processHookInput`, bin, `src/`) → Tasks 1–6. ✅
- `package.json` `bin`, zero-dep, `private:true` → Task 2 + Global Constraints. ✅
- Audit `INVERITA_GUARD_LOG_DIR` override → Task 1. ✅
- Testing matrix (parity, check, doctor, serve, install) → each task's tests. ✅
- Distribution (`npm i -g github:`) → Task 7. ✅
- Enforcement ceiling documented → spec (already committed) + Task 7 serve warning. ✅

**Placeholder scan:** No TBD/TODO; every code and test step contains complete content. ✅

**Type consistency:** `processHookInput(raw) -> {stdout}` used identically in bin (Task 2) and serve (Task 5); `runCheck` verdict shape `{decision,tier,category}` consistent (Task 3); `runDoctor` result `{ok,checks[]}` consistent (Task 4 + bin); `mergeHookIntoSettings -> {settings, already}` and `installToUserSettings -> {written, already}` consistent (Task 6). Hook command string is `inverita-guard` everywhere. ✅
