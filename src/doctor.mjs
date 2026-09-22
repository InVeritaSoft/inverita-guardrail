import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { detect } from '../hooks/pre-prompt-guard.mjs';
import { resolveEnvironment } from './environment.mjs';

// A synthetic identifier (never a real SSN) used to prove the wired CLI actually
// dispatches and blocks end-to-end — not just that a command string is present.
const PROBE_PAYLOAD = JSON.stringify({
  prompt: 'patient SSN is 123-45-6789',
  session_id: 'doctor-probe',
  cwd: '.',
});

// Execute the resolved CLI in guard mode with the probe on stdin. This is the
// exact path that silently no-op'd on symlinked (global npm) installs, so a real
// invocation is the only way to catch a dispatch regression.
export function probeDispatch(bin) {
  const r = spawnSync(bin, [], { input: PROBE_PAYLOAD, encoding: 'utf8', timeout: 5000 });
  return { stdout: r.stdout || '', status: r.status ?? null, error: r.error || null };
}

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

export function runDoctor({
  env,
  homedir,
  cwd,
  platform,
  nodeVersion,
  detect: detectFn = detect,
  probe: probeFn = probeDispatch,
}) {
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

  // Informational, never a failure: 'unknown' is a perfectly healthy state
  // (it means the guard behaves exactly as it did before environment
  // awareness). Surfaced so a developer can see WHY their prompts are being
  // treated strictly or leniently in this directory.
  const resolved = resolveEnvironment({ cwd, env, prompt: '' });
  checks.push({
    name: 'environment (informational)',
    ok: true,
    detail:
      resolved.source === 'default'
        ? 'unknown here — resolved per prompt; mode alone decides Layer 2'
        : `${resolved.environment} (from ${resolved.source}${resolved.marker ? `: "${resolved.marker}"` : ''})`,
  });

  const blocks = !!detectFn('patient SSN is 123-45-6789');
  const clean = detectFn('refactor the scheduler component') === null;
  checks.push({
    name: 'detector smoke test',
    ok: blocks && clean,
    detail: blocks && clean ? 'block+clean OK' : 'detector misbehaving',
  });

  // End-to-end: actually run the CLI in guard mode and confirm it emits a block.
  // Catches the silent-no-op dispatch bug that a presence-only check misses.
  if (!bin) {
    checks.push({
      name: 'CLI dispatches (end-to-end)',
      ok: false,
      detail: 'skipped: CLI not on PATH',
    });
  } else {
    let dispatchOk = false;
    let detail;
    try {
      const { stdout, status, error } = probeFn(bin);
      if (error) {
        detail = `could not run CLI: ${error.message || error}`;
      } else {
        let decision;
        try {
          decision = JSON.parse(stdout)?.decision;
        } catch {
          /* non-JSON or empty stdout → silent no-op */
        }
        dispatchOk = decision === 'block';
        detail = dispatchOk
          ? 'CLI blocked the probe as expected'
          : `CLI did not block the probe (status=${status}, stdout=${JSON.stringify(stdout.slice(0, 80))})`;
      }
    } catch (e) {
      detail = `probe threw: ${e.message}`;
    }
    checks.push({ name: 'CLI dispatches (end-to-end)', ok: dispatchOk, detail });
  }

  return { ok: checks.every((c) => c.ok), checks };
}
