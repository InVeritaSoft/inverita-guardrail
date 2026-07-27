import fs from 'node:fs';
import path from 'node:path';

export function buildUserHookGroup() {
  return { hooks: [{ type: 'command', command: 'inverita-guard', timeout: 10 }] };
}

export function buildManagedSettings() {
  // Only `allowManagedHooksOnly` is needed to enforce the guard as the sole
  // UserPromptSubmit hook. We deliberately do NOT emit
  // `strictPluginOnlyCustomization` here: that flag also blocks user/project
  // skills, agents, hooks AND MCP servers, which breaks developers' own MCP
  // setups. It is opt-in total lockdown, documented in the example file — not
  // part of the default guard enforcement.
  return {
    hooks: { UserPromptSubmit: [buildUserHookGroup()] },
    allowManagedHooksOnly: true,
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
