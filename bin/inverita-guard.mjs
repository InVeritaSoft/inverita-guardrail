#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import os from 'node:os';
import process from 'node:process';
import { processHookInput } from '../hooks/pre-prompt-guard.mjs';
import { runCheck } from '../src/check.mjs';
import { runDoctor } from '../src/doctor.mjs';

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
} else {
  process.stderr.write(`unknown command: ${cmd}\n`);
  printHelp();
  process.exit(2);
}
