#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { processHookInput } from '../hooks/pre-prompt-guard.mjs';
import { runCheck } from '../src/check.mjs';
import { runDoctor } from '../src/doctor.mjs';
import { startServer } from '../src/serve.mjs';
import { buildManagedSettings, installToUserSettings, mergeHookIntoSettings } from '../src/install.mjs';
import { readStream } from '../src/stdin.mjs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const HELP =
  `inverita-guard ${pkg.version}\n\n` +
  `Usage:\n` +
  `  inverita-guard                 Guard mode: read hook JSON on stdin, print decision (exit 0)\n` +
  `  inverita-guard check <prompt>  Test the detector against a prompt\n` +
  `  inverita-guard doctor          Verify install + hook wiring (exit 0 if healthy)\n` +
  `  inverita-guard serve           Run the HTTP-hook endpoint\n` +
  `  inverita-guard install         Wire the hook into ~/.claude/settings.json\n` +
  `  inverita-guard --version\n` +
  `  inverita-guard --help\n`;

const banner = (host, port) =>
  `[inverita-guard] serving on http://${host}:${port}\n` +
  `WARNING: every prompt (possibly containing PHI) is POSTed here — run this\n` +
  `endpoint only inside your compliance boundary. Claude Code fails OPEN on\n` +
  `connection error/timeout.\n`;

/**
 * The default IO environment, bound to the real process. Every external
 * dependency the CLI touches (streams, env, filesystem home, platform, the
 * server factory) is funnelled through this object so `run()` can be exercised
 * in-process with the terminal/stdin conditions the test wants.
 */
function defaultIo() {
  return {
    write: (s) => process.stdout.write(s),
    writeErr: (s) => process.stderr.write(s),
    readStdin: () => readStream(process.stdin),
    isTTY: !!process.stdin.isTTY,
    env: process.env,
    homedir: os.homedir(),
    cwd: process.cwd(),
    platform: process.platform,
    nodeVersion: process.version,
    startServer,
  };
}

/**
 * Dispatch one CLI invocation. Pure with respect to `io`: it performs no direct
 * process IO, sets no process.exitCode, and never calls process.exit(). Returns
 * `{ code }` — the intended exit code — plus `{ server }` for `serve`, whose
 * lifecycle the caller owns.
 */
export async function run(argv, io = defaultIo()) {
  const cmd = argv[0];

  if (cmd === undefined) {
    // Interactive terminal with no piped payload: show help instead of
    // blocking forever on a stdin that will never deliver a hook payload.
    if (io.isTTY) {
      io.write(HELP);
      return { code: 0 };
    }
    const { stdout } = processHookInput(await io.readStdin());
    io.write(stdout);
    return { code: 0 };
  }

  if (cmd === '--version' || cmd === '-v') {
    io.write(`${pkg.version}\n`);
    return { code: 0 };
  }

  if (cmd === '--help' || cmd === '-h') {
    io.write(HELP);
    return { code: 0 };
  }

  if (cmd === 'check') {
    const rest = argv.slice(1);
    const json = rest.includes('--json');
    const promptArg = rest.filter((a) => a !== '--json')[0];
    let prompt = promptArg;
    // Only fall back to stdin when a prompt wasn't supplied AND input is piped;
    // on a bare terminal there is nothing to read and we'd hang.
    if (prompt === undefined && !io.isTTY) prompt = await io.readStdin();
    const verdict = runCheck(prompt || '');
    if (json) {
      io.write(`${JSON.stringify(verdict)}\n`);
    } else if (verdict.decision === 'block') {
      io.write(`BLOCK  tier=${verdict.tier}  category=${verdict.category}\n`);
    } else {
      io.write('CLEAN\n');
    }
    return { code: verdict.decision === 'block' ? 1 : 0 };
  }

  if (cmd === 'doctor') {
    const json = argv.includes('--json');
    const result = runDoctor({
      env: io.env,
      homedir: io.homedir,
      cwd: io.cwd,
      platform: io.platform,
      nodeVersion: io.nodeVersion,
    });
    if (json) {
      io.write(`${JSON.stringify(result)}\n`);
    } else {
      for (const c of result.checks) {
        io.write(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}  (${c.detail})\n`);
      }
      io.write(`\n${result.ok ? 'OK: guard is healthy' : 'PROBLEM: see FAIL lines above'}\n`);
    }
    return { code: result.ok ? 0 : 1 };
  }

  if (cmd === 'serve') {
    const rest = argv.slice(1);
    const portIdx = rest.indexOf('--port');
    const hostIdx = rest.indexOf('--host');
    const port = portIdx >= 0 ? Number(rest[portIdx + 1]) : 8787;
    const host = hostIdx >= 0 ? rest[hostIdx + 1] : '127.0.0.1';
    io.writeErr(banner(host, port));
    const server = io.startServer({ host, port });
    return { code: 0, server };
  }

  if (cmd === 'install') {
    const rest = argv.slice(1);
    if (rest.includes('--managed')) {
      io.write(`${JSON.stringify(buildManagedSettings(), null, 2)}\n`);
      return { code: 0 };
    }
    const file = path.join(io.homedir, '.claude', 'settings.json');
    if (rest.includes('--print')) {
      let current = {};
      try {
        current = JSON.parse(readFileSync(file, 'utf8'));
      } catch {
        current = {};
      }
      io.write(`${JSON.stringify(mergeHookIntoSettings(current).settings, null, 2)}\n`);
      return { code: 0 };
    }
    const r = installToUserSettings(file);
    io.write(
      r.already
        ? `inverita-guard hook already present in ${file}\n`
        : `wired inverita-guard UserPromptSubmit hook into ${file}\n`,
    );
    return { code: 0 };
  }

  io.writeErr(`unknown command: ${cmd}\n`);
  io.write(HELP);
  return { code: 2 };
}

// Only dispatch when executed directly, so tests can import run() without it
// firing on module load.
const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  const { code, server } = await run(process.argv.slice(2));
  if (server) {
    // serve is long-lived: keep the process up until a signal or the
    // controlling stdin pipe (EOF) tells us to shut down, then exit cleanly.
    const shutdown = () => {
      server.close(() => {
        process.exitCode = code;
      });
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    process.stdin.on('end', shutdown);
    process.stdin.resume();
  } else {
    process.exitCode = code;
  }
}
