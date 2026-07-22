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
