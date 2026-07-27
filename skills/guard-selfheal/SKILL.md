---
name: guard-selfheal
description: Diagnose and safely repair the inverita-guardrail PHI guard. Use when the guard seems inactive, misconfigured, or not blocking; when a developer reports Claude Code / MCP / hooks broke after the guard rollout; when verifying the guard is wired correctly (CLI or VS Code extension); or when someone asks to "check", "fix", "heal", or "doctor" the guard. Read-only diagnosis first; repairs are additive, idempotent, and never disable the user's Claude Code.
---

# inverita-guardrail: self-diagnose & self-heal

This skill checks whether the PHI guard is installed and wired correctly and, if
not, repairs it **without ever breaking the developer's Claude Code**. It works
for both the Claude Code CLI and the VS Code extension (which share the same
settings hierarchy and hooks).

## Absolute safety rules (never violate — these protect the developer's setup)

1. **Never touch managed settings.** The system-level `managed-settings.json`
   (`/etc/claude-code/…`, `/Library/Application Support/ClaudeCode/…`,
   `C:\Program Files\ClaudeCode\…`) is admin-owned. Read it for diagnosis only;
   **never edit or delete it.** If the problem is in managed settings, STOP and
   tell the user to contact their org admin.
2. **Never remove or disable anything the developer already has.** Do not delete
   or overwrite existing hooks, MCP servers, skills, or agents in
   `~/.claude/settings.json` or `.claude/settings.json`. All repairs are
   **additive** to the guard's own hook entry only.
3. **Never add `strictPluginOnlyCustomization`.** That flag disables the
   developer's own MCP servers, skills, and agents. It is not needed for the
   guard. If you find it set in *user/project* settings, offer to remove it; if
   it's in *managed* settings, escalate to the admin (rule 1).
4. **Back up before any write.** Before editing a settings file, copy it to
   `<file>.bak-<ISO-timestamp>` and tell the user where the backup is.
5. **Idempotent & reversible.** Re-running heal must be a no-op when healthy.
   Prefer `inverita-guard install` (idempotent) over hand-editing JSON.
6. **Fail safe, not open-ended.** If a repair is ambiguous, risky, or would
   require touching anything outside the guard's own hook entry, do **not** guess
   — report the finding and the exact manual step instead.
7. **A block is not a bug.** If the guard correctly blocked a PHI-shaped prompt,
   that is expected behavior. Do not "heal" a working guard into silence.
8. **Advisory mode is not a fault.** If a developer reports that clinical wording
   (Layer 2) is *not* being blocked, first check the effective mode
   (`INVERITA_GUARD_MODE` env, or the nearest `.inverita-guard.json` walking up
   from the repo). In `advisory` mode Layer 2 only warns by design — that is
   correct, not broken. Layer 1 identifiers (SSN/MRN/DOB/…) block in every mode;
   if a Layer 1 identifier is genuinely not blocked, that IS a real fault
   (proceed to diagnose). To make Layer 2 block for a healthcare repo, add
   `{"mode":"enforce"}` (or `{"healthcare":true}`) to `.inverita-guard.json`, or
   have the org pin `INVERITA_GUARD_MODE=enforce` in managed settings — never
   weaken enforcement to "fix" a report.

## Step 1 — Diagnose (read-only)

Run these and collect the output; do not change anything yet:

```bash
inverita-guard --version          # CLI present + version
inverita-guard doctor --json      # 4 checks: node>=18, PATH, hook wired, smoke test
```

`doctor --json` returns `{ ok, checks: [{ name, ok, detail }, …] }`. Also, for a
GUI-launched VS Code check, inspect (read-only) whether the wired hook command is
a **bare name** (`"command": "inverita-guard"`) versus an **absolute/exec form**
— see Step 2, fix C.

If the CLI itself is missing (`inverita-guard: command not found`), run the hook
directly to confirm the detector still works, then treat it as fix B:

```bash
printf '{"prompt":"refactor the scheduler","session_id":"diag","cwd":"."}' \
  | node hooks/pre-prompt-guard.mjs
```

Inside Claude Code (CLI or VS Code chat panel), also have the user run `/status`
(look for *Enterprise managed settings* on the *Setting sources* line), `/mcp`
(confirm their MCP servers are connected), and `/hooks` if available.

Then present a short table: each check, PASS/FAIL, and the `detail`.

## Step 2 — Heal (only the failing checks, safely)

Apply only the fix for each failing check. Re-run `inverita-guard doctor` after.

- **Fix A — `node>=18` fails.** Do not auto-install Node. Tell the user to
  upgrade to Node 18+ and stop; nothing else can be verified until then.

- **Fix B — `inverita-guard on PATH` fails (CLI missing).** Recommend a global
  reinstall and let the user run it (it modifies their global npm prefix):
  `npm i -g github:InVeritaSoft/inverita-guardrail`. On a managed/offline fleet,
  point them at their internal distribution instead.

- **Fix C — `hook wired` fails, or the wired command is a bare name that a
  GUI-launched VS Code can't resolve on PATH.**
  - If the guard is delivered via **managed settings** (from `/status`),
    do **nothing** to files — this is the admin's job. Report it.
  - If it should be wired in **user** settings: back up
    `~/.claude/settings.json` (rule 4), then run `inverita-guard install`
    (idempotent, additive).
  - For the **VS Code PATH-robustness** case, prefer the **exec form** so the
    hook resolves without a shell PATH lookup. After backing up, ensure the
    guard's own `UserPromptSubmit` entry uses:
    ```json
    { "type": "command", "command": "node",
      "args": ["<ABSOLUTE-PATH>/hooks/pre-prompt-guard.mjs"], "timeout": 10 }
    ```
    Use an absolute path to the deployed `pre-prompt-guard.mjs`. Do not remove
    any other hook entries. If you cannot determine the absolute path safely,
    stop and show the user the exact edit to make by hand.

- **Fix D — `detector smoke test` fails.** The detector code itself is broken or
  the deployed copy is stale/corrupt. Do not patch it in place. Recommend
  reinstalling the guard (fix B) or re-deploying the managed copy, and report the
  `detail` string.

## Step 3 — Confirm

Re-run `inverita-guard doctor` (or `--json`) and show the user the now-green
checks. If anything is still failing after the safe fixes, summarize exactly
what remains and who needs to act (developer vs. org admin) — never leave the
guard in a half-edited state.

## What this skill will NOT do

- Will not disable, bypass, or weaken the guard.
- Will not edit managed settings or remove the developer's MCP/hooks/skills.
- Will not add `strictPluginOnlyCustomization`.
- Will not upgrade Node or run global installs on the user's behalf without
  telling them exactly what runs.
