import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run } from '../cli/inverita-guard.mjs';

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

test('check with no arg and piped stdin reads the prompt', async () => {
  const { io, out } = harness({
    isTTY: false,
    readStdin: async () => 'prescribe 10mg twice daily',
  });
  const { code } = await run(['check', '--json'], io);
  assert.equal(code, 1);
  assert.equal(JSON.parse(out.stdout).category, 'medication_dosage');
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
