import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { run, isInvokedDirectly } from '../cli/inverita-guard.mjs';

// A capturing IO harness so run() can be exercised in-process under any
// terminal/stdin condition — including a real TTY, which a spawned subprocess
// cannot fake.
function harness(overrides = {}) {
  const out = { stdout: '', stderr: '' };
  const io = {
    write: (s) => (out.stdout += s),
    writeErr: (s) => (out.stderr += s),
    readStdin: async () => '',
    isTTY: false,
    env: { PATH: '' },
    homedir: fs.mkdtempSync(path.join(os.tmpdir(), 'run-home-')),
    cwd: process.cwd(),
    platform: 'linux',
    nodeVersion: 'v20.0.0',
    startServer: () => ({ closed: true }),
    ...overrides,
  };
  return { io, out };
}

test('no command on a TTY prints help (interactive branch)', async () => {
  const { io, out } = harness({ isTTY: true });
  const { code } = await run([], io);
  assert.equal(code, 0);
  assert.match(out.stdout, /Usage:/);
});

test('no command with piped stdin runs guard mode and blocks PHI', async () => {
  const { io, out } = harness({
    isTTY: false,
    readStdin: async () => JSON.stringify({ prompt: 'patient SSN is 123-45-6789' }),
  });
  const { code } = await run([], io);
  assert.equal(code, 0);
  assert.match(out.stdout, /"decision":"block"/);
});

test('check with no arg on a TTY does not read stdin (uses empty prompt)', async () => {
  let read = false;
  const { io, out } = harness({
    isTTY: true,
    readStdin: async () => {
      read = true;
      return 'patient SSN is 123-45-6789';
    },
  });
  const { code } = await run(['check'], io);
  assert.equal(read, false, 'stdin must not be read on a TTY');
  assert.equal(code, 0);
  assert.match(out.stdout, /CLEAN/);
});

test('check with no arg and piped stdin reads the prompt (enforce blocks L2)', async () => {
  const { io, out } = harness({
    isTTY: false,
    readStdin: async () => 'prescribe 10mg twice daily',
  });
  const { code } = await run(['check', '--json', '--mode', 'enforce'], io);
  assert.equal(code, 1);
  const v = JSON.parse(out.stdout);
  assert.equal(v.category, 'medication_dosage');
  assert.equal(v.action, 'block');
});

test('check resolves mode from io (env override) when --mode is absent', async () => {
  const { io, out } = harness({
    isTTY: false,
    env: { INVERITA_GUARD_MODE: 'enforce' },
    readStdin: async () => 'prescribe 10mg twice daily',
  });
  const { code } = await run(['check', '--json'], io);
  assert.equal(code, 1, 'env INVERITA_GUARD_MODE=enforce should make L2 block');
  assert.equal(JSON.parse(out.stdout).action, 'block');
});

test('check (text mode) prints a WARN line for advisory Layer 2', async () => {
  const { io, out } = harness();
  const { code } = await run(['check', '--mode', 'advisory', 'prescribe 10mg twice daily'], io);
  assert.equal(code, 0);
  assert.match(out.stdout, /^WARN\s+tier=2\s+category=medication_dosage\s+\(mode: advisory, allowed\)/m);
});

test('check with an invalid --mode value falls back to resolved mode', async () => {
  // modeIdx >= 0 but the value is not a valid mode → resolveMode() is used.
  const { io, out } = harness({ env: {} });
  const { code } = await run(['check', '--mode', 'bogus', 'patient SSN is 123-45-6789'], io);
  assert.equal(code, 1, 'Layer 1 still blocks regardless of the resolved mode');
  assert.match(out.stdout, /BLOCK/);
});

test('check (text mode) prints an EXCEPTED line for a project exception', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-cwd-'));
  fs.writeFileSync(
    path.join(dir, '.inverita-guard.json'),
    JSON.stringify({ exceptions: [{ category: 'medication_dosage', reason: 'pharmacy app' }] }),
  );
  const { io, out } = harness({ cwd: dir });
  const { code } = await run(['check', '--mode', 'enforce', 'prescribe 10mg twice daily'], io);
  assert.equal(code, 0, 'an excepted category must not be treated as a block');
  assert.match(out.stdout, /^EXCEPTED\s+tier=2\s+category=medication_dosage\s+\(project exception, allowed\)/m);
});

test('exceptions list: reports none configured, then the added ones as JSON', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-cwd-'));
  const { io: io1, out: out1 } = harness({ cwd: dir });
  await run(['exceptions', 'list'], io1);
  assert.match(out1.stdout, /No project exceptions configured/);

  fs.writeFileSync(
    path.join(dir, '.inverita-guard.json'),
    JSON.stringify({ exceptions: [{ category: 'icd_code', reason: 'billing app' }] }),
  );
  const { io: io2, out: out2 } = harness({ cwd: dir });
  const { code } = await run(['exceptions', 'list', '--json'], io2);
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(out2.stdout), [{ category: 'icd_code', reason: 'billing app' }]);
});

test('exceptions list (text mode) prints category and reason', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-cwd-'));
  fs.writeFileSync(
    path.join(dir, '.inverita-guard.json'),
    JSON.stringify({ exceptions: [{ category: 'icd_code', reason: 'billing app' }] }),
  );
  const { io, out } = harness({ cwd: dir });
  await run(['exceptions', 'list'], io);
  assert.match(out.stdout, /icd_code.*billing app/);
});

test('exceptions add: succeeds for a Layer-2 category with a reason', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-cwd-'));
  const { io, out } = harness({ cwd: dir });
  const { code } = await run(['exceptions', 'add', 'medication_dosage', '--reason', 'pharmacy app'], io);
  assert.equal(code, 0);
  assert.match(out.stdout, /added exception: medication_dosage/);
  const written = JSON.parse(fs.readFileSync(path.join(dir, '.inverita-guard.json'), 'utf8'));
  assert.deepEqual(written.exceptions, [{ category: 'medication_dosage', reason: 'pharmacy app' }]);
});

test('exceptions add: refuses a Layer-1 category and exits 2', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-cwd-'));
  const { io, out } = harness({ cwd: dir });
  const { code } = await run(['exceptions', 'add', 'ssn_pattern', '--reason', 'trust me'], io);
  assert.equal(code, 2);
  assert.match(out.stderr, /never be excepted/);
  assert.equal(fs.existsSync(path.join(dir, '.inverita-guard.json')), false);
});

test('exceptions remove: removes an existing exception', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-cwd-'));
  fs.writeFileSync(
    path.join(dir, '.inverita-guard.json'),
    JSON.stringify({ exceptions: [{ category: 'icd_code', reason: 'a' }] }),
  );
  const { io, out } = harness({ cwd: dir });
  const { code } = await run(['exceptions', 'remove', 'icd_code'], io);
  assert.equal(code, 0);
  assert.match(out.stdout, /removed exception: icd_code/);
});

test('exceptions remove: reports a no-op when the category is absent', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-cwd-'));
  const { io, out } = harness({ cwd: dir });
  const { code } = await run(['exceptions', 'remove', 'icd_code'], io);
  assert.equal(code, 0);
  assert.match(out.stdout, /no exception found for: icd_code/);
});

test('exceptions: unknown subcommand exits 2 and prints help', async () => {
  const { io, out } = harness();
  const { code } = await run(['exceptions', 'bogus'], io);
  assert.equal(code, 2);
  assert.match(out.stderr, /unknown exceptions subcommand/);
  assert.match(out.stdout, /Usage:/);
});

test('update: npm succeeds, runs doctor verification, reports PROBLEM when unwired', async () => {
  let calledCmd, calledArgs;
  const { io, out } = harness({
    spawnSync: (cmd, args) => {
      calledCmd = cmd;
      calledArgs = args;
      return { status: 0, stdout: 'added 1 package\n', stderr: '', error: null };
    },
  });
  const { code } = await run(['update'], io);
  assert.equal(calledCmd, 'npm');
  assert.deepEqual(calledArgs, ['i', '-g', 'github:InVeritaSoft/inverita-guardrail']);
  assert.match(out.stdout, /added 1 package/);
  assert.match(out.stdout, /Verifying with doctor/);
  // harness()'s empty PATH/homedir mean doctor won't be fully healthy — the
  // update step itself still succeeded, but the exit code reflects doctor.
  assert.equal(code, 1);
  assert.match(out.stdout, /PROBLEM: see FAIL lines above/);
});

test('update --tag pins a specific ref', async () => {
  let calledArgs;
  const { io } = harness({
    spawnSync: (_cmd, args) => {
      calledArgs = args;
      return { status: 0, stdout: '', stderr: '', error: null };
    },
  });
  await run(['update', '--tag', 'v0.1.9'], io);
  assert.deepEqual(calledArgs, ['i', '-g', 'github:InVeritaSoft/inverita-guardrail#v0.1.9']);
});

test('update: npm exits nonzero — reports failure and does not run doctor', async () => {
  const { io, out } = harness({
    spawnSync: () => ({ status: 1, stdout: '', stderr: 'npm ERR! network timeout\n', error: null }),
  });
  const { code } = await run(['update'], io);
  assert.equal(code, 1);
  assert.match(out.stderr, /npm ERR! network timeout/);
  assert.match(out.stderr, /update failed: npm exited with code 1/);
  assert.doesNotMatch(out.stdout, /Verifying with doctor/);
});

test('update: npm cannot be spawned at all — reports failure and does not run doctor', async () => {
  const { io, out } = harness({
    spawnSync: () => ({ status: null, stdout: '', stderr: '', error: new Error('ENOENT') }),
  });
  const { code } = await run(['update'], io);
  assert.equal(code, 1);
  assert.match(out.stderr, /update failed: could not run npm \(ENOENT\)/);
  assert.doesNotMatch(out.stdout, /Verifying with doctor/);
});

test('update: fully healthy after update reports OK and exits 0', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'run-home-'));
  const claude = path.join(home, '.claude');
  fs.mkdirSync(claude, { recursive: true });
  fs.writeFileSync(
    path.join(claude, 'settings.json'),
    JSON.stringify({
      hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'inverita-guard' }] }] },
    }),
  );
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-bin-'));
  fs.writeFileSync(
    path.join(binDir, 'inverita-guard'),
    '#!/bin/sh\ncat >/dev/null\nprintf \'{"decision":"block","reason":"stub"}\'\n',
    { mode: 0o755 },
  );
  const { io, out } = harness({
    homedir: home,
    env: { PATH: `${binDir}${path.delimiter}${process.env.PATH}` },
    spawnSync: () => ({ status: 0, stdout: '', stderr: '', error: null }),
  });
  const { code } = await run(['update'], io);
  assert.equal(code, 0);
  assert.match(out.stdout, /OK: guard is healthy \(updated\)/);
});

test('serve returns a server handle and writes the banner', async () => {
  let opts;
  const fakeServer = { fake: true };
  const { io, out } = harness({
    startServer: (o) => {
      opts = o;
      return fakeServer;
    },
  });
  const { code, server } = await run(['serve', '--host', '0.0.0.0', '--port', '9000'], io);
  assert.equal(code, 0);
  assert.equal(server, fakeServer);
  assert.deepEqual(opts, { host: '0.0.0.0', port: 9000 });
  assert.match(out.stderr, /serving on http:\/\/0\.0\.0\.0:9000/);
});

test('unknown command returns exit code 2 and prints help', async () => {
  const { io, out } = harness();
  const { code } = await run(['bogus'], io);
  assert.equal(code, 2);
  assert.match(out.stderr, /unknown command/);
  assert.match(out.stdout, /Usage:/);
});

test('isInvokedDirectly matches through a symlink (global npm install)', () => {
  // Node loads the module via its realpath, so import.meta.url is the realpath.
  // A symlinked bin (process.argv[1]) must still be recognized as direct
  // invocation — otherwise every subcommand is a silent no-op.
  const cliReal = path.resolve(fileURLToPath(import.meta.url), '..', '..', 'cli', 'inverita-guard.mjs');
  const moduleUrl = pathToFileURL(cliReal).href;

  // Direct (non-symlinked) invocation still matches.
  assert.equal(isInvokedDirectly(cliReal, moduleUrl), true);

  // A symlink pointing at the real CLI must resolve to the same realpath.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-link-'));
  const link = path.join(dir, 'inverita-guard');
  fs.symlinkSync(cliReal, link);
  assert.equal(isInvokedDirectly(link, moduleUrl), true);

  // Imported as a module (no argv[1]) is not a direct invocation.
  assert.equal(isInvokedDirectly(undefined, moduleUrl), false);

  // A non-existent argv[1] falls back to the raw path (no throw) and won't match.
  assert.equal(isInvokedDirectly(path.join(dir, 'does-not-exist'), moduleUrl), false);
});
