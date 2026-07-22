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
