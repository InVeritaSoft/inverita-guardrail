# inverita-guardrail

A Claude Code guard that runs a **mandatory PHI-safety check on every prompt**
for the PixelCare Health project. It blocks prompts that look like they contain
protected health information (PHI) or unnecessary clinical specifics *before
they reach Claude*. It ships two ways:

- as an **opt-in plugin** (via the marketplace) for developers who install it
  voluntarily, and
- as an **org-wide managed hook** delivered through managed settings, so
  individual developers cannot disable or bypass it.

> [!IMPORTANT]
> **There is no supported way to force-*install* a named plugin onto the Claude
> Code CLI.** The claude.ai admin console's "Required" / auto-install plugin
> preferences target Cowork and claude.ai web/mobile — on the CLI an org plugin
> is only *made available*, and the developer still installs it. Org-wide
> **enforcement** is therefore done by delivering the guard as a **managed
> hook** (managed settings register the `UserPromptSubmit` hook directly),
> **not** by force-enabling a plugin. See [Force-enforcement](#force-enforcement-for-admins).

> [!IMPORTANT]
> This is a **client-side filter**, not a compliance boundary. It reduces
> *accidental* PHI exposure in prompts. It is **not** a substitute for a
> BAA and HIPAA-compliant upstream data pipeline. **Real PHI must never be
> typed into any prompt, regardless of this guard.**

---

## Quick start (developers)

```bash
# 1. Install the CLI (creates the per-OS `inverita-guard` PATH shim)
npm i -g github:InVeritaSoft/inverita-guardrail

# 2. Wire it into your own Claude Code settings (idempotent)
inverita-guard install

# 3. Confirm everything is healthy (Node ≥18, on PATH, hook wired, smoke test)
inverita-guard doctor

# 4. Try the detector on a prompt without involving Claude
inverita-guard check "prescribe 10mg twice daily"   # → BLOCK  tier=2  category=medication_dosage
inverita-guard check "refactor the scheduler"        # → CLEAN
```

Working on the guard itself instead of installing it? Clone the repo and run
`npm test` (see [Testing](#testing)) — it has zero third-party dependencies.

> On a team-managed machine the hook is delivered centrally and you don't run
> step 2 yourself — see [Force-enforcement](#force-enforcement-for-admins).

---

## What it does

On every prompt (`UserPromptSubmit` hook, no matcher — fires on all prompts):

| Tier | What it catches | Confidence | `enforce` | `advisory` |
|------|-----------------|------------|-----------|------------|
| **Layer 1 — identifiers** | SSNs, MRN/patient-ID tokens, DOB next to a name, email + clinical terms, insurance/policy numbers | High | **Block** | **Block** |
| **Layer 2 — clinical specifics** | ICD-code-shaped tokens, medication + dosage, lab/vital values, clinical-narrative phrasing, age + condition | Lower / broad net | **Block** | **Warn** (allowed through) |
| No match | — | — | Allow + reminder | Allow + reminder |

The **reason message names the tier and category** (`identifier: ssn_pattern` vs
`clinical specificity: medication_dosage`) so developers can self-correct
quickly, and Layer 2 blocks are framed as "clinical specificity" (non-shaming,
likely-false-positive-aware) rather than "you leaked PHI".

### Enforcement modes (flexibility)

The guard is **project-scoped**: it hard-enforces where it matters and stays out
of the way elsewhere. **Layer 1 identifiers always block, in every mode** — real
identifiers must never leave. Only the broad **Layer 2** net changes:

- **`enforce`** — Layer 1 + Layer 2 both block (full strictness).
- **`advisory`** — Layer 1 blocks; Layer 2 does **not** block. Instead it injects
  a caution into the prompt context (the model is told what tripped and to use
  synthetic data) and lets the prompt through. This removes Layer 2
  false-positive friction on non-medical work.

**Mode resolution (highest priority first):**

1. **`INVERITA_GUARD_MODE`** env var (`enforce` | `advisory`). An org can pin
   `enforce` fleet-wide by setting it in managed settings — this is the
   recommended way to guarantee full enforcement on healthcare machines.
2. The nearest **`.inverita-guard.json`** walking up from the project, e.g.
   `{ "mode": "enforce" }` or the shorthand `{ "healthcare": true }` (→ enforce).
   See `examples/.inverita-guard.json`.
3. **Default: `advisory`.**

Test how a prompt resolves in either mode with the CLI:

```bash
inverita-guard check --mode enforce  "prescribe 10mg twice daily"   # BLOCK
inverita-guard check --mode advisory "prescribe 10mg twice daily"   # WARN (allowed)
inverita-guard check "patient SSN is 123-45-6789"                    # BLOCK in ANY mode
```

If the hook cannot read its input payload, it **fails open with a warning**
(injects a context note that the check was skipped) rather than bricking the
prompt — a deliberate choice so a future input-schema change can't wedge every
developer's Claude Code.

### Audit log

Every block appends one JSON line to `logs/audit.jsonl`:

```json
{"ts":"2026-07-14T09:15:22.104Z","session_id":"abc123","tier":1,"category":"ssn_pattern","mode":"enforce","action":"block"}
```

- **Metadata only.** It records timestamp, session id, tier, category, the
  resolved `mode`, and the `action` (`block` / `warn`) — **never the matched
  text or the original prompt.**
- **Local only.** Nothing is transmitted anywhere. The org's compliance
  reviewer pulls it manually from the developer's machine.
- **Capped + rotated.** At 5 MB, `audit.jsonl` is rotated to `audit.jsonl.1`
  (a single previous generation, overwritten on the next rotation).
- The log is git-ignored. Note that **this log is itself metadata that may be
  subject to your internal data-handling policy** (it reveals when/how often a
  developer tripped the guard) — treat and retain it accordingly.

---

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
| `inverita-guard check "<prompt>"` | Test the detector against a prompt. Exit 1 if it would **block** (0 for warn/clean). `--json` for machine output; `--mode enforce\|advisory` to force the mode (otherwise resolved from env + `.inverita-guard.json`). |
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

---

## Self-heal skill

The plugin ships a Claude Code skill, **`guard-selfheal`**
(`skills/guard-selfheal/SKILL.md`), that diagnoses and repairs the guard from
inside Claude Code — useful when a developer reports the guard isn't blocking,
or that MCP/hooks broke after a rollout. Invoke it by asking Claude to "check /
fix / heal the inverita guard" (or `/guard-selfheal` if exposed as a command).

It is **safe by construction** — the skill's instructions forbid anything that
could break a developer's Claude Code:

- **read-only diagnosis first** (`inverita-guard doctor`, `/status`, `/mcp`);
- repairs are **additive and idempotent** (prefers `inverita-guard install`),
  and it **backs up** any settings file before editing;
- it **never** edits managed settings, **never** removes the developer's own
  hooks/MCP/skills/agents, and **never** adds `strictPluginOnlyCustomization`
  (the flag that disables user MCP);
- managed-scope problems are **escalated to the admin**, not silently patched;
- for GUI-launched VS Code it repairs the hook to the PATH-robust **exec form**
  (`"command": "node", "args": ["<abs>/hooks/pre-prompt-guard.mjs"]`).

---

## Force-enforcement (for admins)

Enforcement on the Claude Code CLI is delivered as a **managed hook**, not a
force-installed plugin (see the note at the top of this README for why). It has
two parts: (1) deploy the guard code to a fixed root-owned path, and (2)
register it as a `UserPromptSubmit` hook via **managed settings**.

Work from `managed-settings/managed-settings.example.json` — copy it, **remove
the `_comment_*` documentation keys**, and adjust the deploy path to match your
fleet.

### 1. Deploy the guard code

Push the **entire plugin directory** (this repo) to a fixed, root-owned path via
your MDM (Jamf, Intune, Ansible, …). Keep the internal layout so `hooks/` and a
**writable** `logs/` subdir both exist.

| OS | Recommended deploy path |
|----|-------------------------|
| Linux | `/opt/inverita-guardrail` |
| macOS | `/Library/Application Support/ClaudeCode/inverita-guardrail` |
| Windows | `C:\Program Files\ClaudeCode\inverita-guardrail` |

The script should be **read-only** to developers. The `logs/` subdir must be
**writable** (e.g. mode `1777`) or the metadata-only audit log is silently
skipped — audit logging fails open by design and never blocks the guard.

### 2. Deliver managed settings

Deliver the managed settings (registering the hook, with `allowManagedHooksOnly`)
via **one** of:

**Option A — MDM-pushed file at a system-level path (recommended for hard
enforcement).** Push the file via your MDM to the OS system path:

| OS | Path |
|----|------|
| macOS | `/Library/Application Support/ClaudeCode/managed-settings.json` |
| Linux / WSL | `/etc/claude-code/managed-settings.json` |
| Windows | `C:\Program Files\ClaudeCode\managed-settings.json` |

These paths are **root/administrator-owned and not user-writable**, so a
developer-level session cannot edit or delete them to bypass the guard.

**Option B — Team/Enterprise admin console (server-managed, refreshes ~hourly).**
Configure the managed settings in the claude.ai admin console and assign them to
the PixelCare Health workspace/users. If a developer edits their local settings,
the managed policy is re-applied on the next (~hourly) refresh. Requires a Claude
for Teams or Enterprise plan. The file/MDM path is stronger for hard enforcement
because it is root-owned and offline.

> [!WARNING]
> Do **not** place the managed settings in `~/.claude/`. That path is
> **user-writable and therefore bypassable** — a developer could simply edit or
> delete it. Managed enforcement requires a path the developer cannot write to
> (admin console delivery or a system-level MDM-pushed file).

### Managed settings contents

The command path must match your step-1 deploy path (Linux shown):

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node /opt/inverita-guardrail/hooks/pre-prompt-guard.mjs",
            "timeout": 10
          }
        ]
      }
    ]
  },
  "allowManagedHooksOnly": true
}
```

> [!WARNING]
> Do **not** add `"strictPluginOnlyCustomization": true` unless you intend a
> full customization lockdown. That flag also blocks **user/project MCP
> servers, skills, and agents** — it will break developers' own MCP setups, and
> it is **not** needed to enforce this guard. See
> [Why `allowManagedHooksOnly`](#why-allowmanagedhooksonly-is-required-for-real-enforcement).

### Verify it's active

Have a developer run `/status` in Claude Code. The **`Setting sources`** line
should show `Enterprise managed settings` with the source in parentheses —
`(file)` for the MDM-pushed `managed-settings.json`, or `(remote)` for
admin-console delivery. That confirms the managed hook is live.

---

## Why `allowManagedHooksOnly` is required for real enforcement

Registering the guard hook in managed settings makes it run. But hooks can
**also** be registered from user (`~/.claude/settings.json`) and project
(`.claude/settings.json`) scopes. Without an additional control, a developer
could register their own competing `UserPromptSubmit` hook, or otherwise
interfere with hook execution.

`"allowManagedHooksOnly": true` tells Claude Code to execute **only** hooks that
originate from **managed settings / managed plugins** and to ignore hooks
defined in user or project settings. This makes the guard the single
authoritative `UserPromptSubmit` hook.

**This flag is the line between "recommended" and "enforced."** The managed hook
without it means the guard runs, but the developer's own hooks run too and the
setup is not tamper-resistant. With both the managed hook *and*
`allowManagedHooksOnly`, there is no developer-level way to silently opt out.

`allowManagedHooksOnly` scopes to **hooks only** — it does **not** touch MCP
servers, skills, or agents, so developers keep their own MCP setups. This is
what the guard ships by default (`inverita-guard install --managed`).

> [!CAUTION]
> `strictPluginOnlyCustomization` is a **separate, much broader** lockdown that
> restricts skills, agents, hooks, **and MCP servers** to plugin/managed
> sources — it will **disable developers' own user/project MCP servers**. It is
> **not** required for this guard and is **off by default**. Enable it only for
> a deliberate full-customization lockdown, and take its exact shape (it can be
> scoped per customization type, e.g. `mcp`) from the official
> [managed MCP docs](https://code.claude.com/docs/en/managed-mcp.md) — not from
> this README.

There is deliberately **no bypass flag, no debug env var that disables the
hook, and no local per-developer override** anywhere in this guard.

---

## This is NOT a substitute for HIPAA-compliant handling

This plugin is a *last-line, best-effort* filter on what gets typed into a
prompt. It:

- **cannot** catch every form of PHI (paraphrased narratives, PHI in attached
  files, PHI a model is asked to *generate*, novel identifier formats, …);
- **does not** make Claude Code a HIPAA-compliant system;
- **does not** replace your BAA, data-processing agreements, access controls,
  de-identification pipeline, or secure handling of the source data.

Treat it as defense-in-depth. The primary control is still: **real PHI never
enters a prompt.** Use synthetic or fully de-identified data for all
development, testing, and examples.

---

## False positives & tuning

The **Layer 2 net is intentionally broad** and *will* flag legitimate non-PHI
prompts. Expect Layer 2 false positives on everyday developer phrasing such as:

- `"add 10mg of spacing"` → `medication_dosage`
- `"the E11 highway config"` → `icd_code`
- `"set glucose_threshold = 126"` → `lab_value`
- `"a 30 year old cache entry with a stale bug"` → `age_condition` (needs a
  condition-ish word nearby)

Layer 1 is tuned to be much quieter (it keys on high-confidence identifier
shapes and proximity), so Layer 1 false positives should be rare.

Because the posture is strict block-by-default with **no local override**, the
developer's recourse when Layer 2 wrongly trips is to **reword the prompt**, or
to **request a tuning change** to the regex config.

### Submitting a tuning request

All detection lives in two exported config objects in
`hooks/pre-prompt-guard.mjs`:

- `LAYER1` — identifier rules
- `LAYER2` — clinical-specificity rules
- `MRN_PATTERNS` — per-EHR MRN/patient-ID shapes (formats vary; tune per EHR)

To request a change:

1. Open an issue in this repo describing the prompt category that mis-fired
   (do **not** paste the real prompt if it contained anything sensitive —
   describe the *shape*, e.g. "`<number>mg` appears in CSS-spacing prompts").
2. The compliance owner triages, edits the relevant regex in `LAYER1`/`LAYER2`
   /`MRN_PATTERNS`, bumps the plugin version, and re-ships it.
3. The updated plugin propagates through the same managed-settings channel
   (admin-console refresh or MDM push). Tuning stays **centrally controlled** —
   there is no per-developer local edit path.

> Two markers are deliberately narrowed to keep the false-positive rate sane:
> the `"history of"` narrative marker only trips when a clinical companion term
> is nearby (so `"git history of the repo"` passes), and MRN detection requires
> a **long** digit run so short synthetic IDs like `PT-0001` — the recommended
> replacement — are never flagged.

---

## Testing

### Automated test suite

An automated suite lives in `test/` and uses Node's built-in test runner
(`node:test`) — no third-party dependencies, matching the plugin's zero-dep
design. It covers every Layer-1 and Layer-2 category, false-positive guards,
tier precedence, the full stdin→stdout hook contract (block / clean /
fail-open, always exit 0), the audit log (metadata-only, no raw text, and
size-cap rotation), and every CLI subcommand (including the interactive-TTY
branches via the injectable `run(argv, io)`). The suite holds **100% line,
branch, and function coverage**.

```bash
npm test                                  # runs `node --test` with auto-discovery
node --test test/guardrail.test.mjs       # a single file
node --experimental-test-coverage --test  # with the coverage report
```

A regression test also asserts that neither entry point calls `process.exit()`
as a statement: `process.exit()` can truncate a buffered stdout write to a
pipe, which would silently drop a block's `reason`. Both entry points set
`process.exitCode` and let Node drain stdout before exiting.

> Use `npm test` (or an explicit file path). `node --test test/` with a
> trailing-slash directory arg fails on Node 25 — it tries to import the
> directory as a module; that is an arg-parsing quirk, not a test failure.

### Manual checklist

Run the hook directly by piping a payload to it. The hook reads
`{ prompt, session_id, cwd }` from stdin.

```bash
# Helper: pipe a prompt through the hook and print its decision JSON.
check () { printf '{"prompt":%s,"session_id":"test","cwd":"."}' \
  "$(node -e 'process.stdout.write(JSON.stringify(process.argv[1]))' "$1")" \
  | node hooks/pre-prompt-guard.mjs; echo; }
```

### Should BLOCK — Layer 1 (identifiers)

- [ ] `check "patient SSN is 123-45-6789"` → block, `ssn_pattern`
- [ ] `check "MRN: 00847213 needs review"` → block, `mrn_pattern`
- [ ] `check "John Smith DOB 04/12/1970 follow-up"` → block, `dob_name_proximity`
- [ ] `check "email jane.doe@acme.com re: patient diagnosis"` → block, `email_clinical`
- [ ] `check "policy number XYZ8841203 on file"` → block, `insurance_policy`

### Should BLOCK — Layer 2 (clinical specificity)

- [ ] `check "code the mapping for E11.9"` → block, `icd_code`
- [ ] `check "prescribe 10mg twice daily"` → block, `medication_dosage`
- [ ] `check "glucose reading was 126 mg/dL"` → block, `lab_value`
- [ ] `check "chief complaint: shortness of breath"` → block, `clinical_narrative`
- [ ] `check "68 year old male with COPD"` → block, `age_condition`

### Should PASS — clean (returns `additionalContext` reminder)

- [ ] `check "refactor the appointment scheduler component"`
- [ ] `check "use synthetic patient PT-0001 in the fixture"`
- [ ] `check "git history of the auth module"` (no clinical companion → passes)
- [ ] `check "increase padding to 8px and margin to 4px"`

### Robustness

- [ ] `printf 'not json' | node hooks/pre-prompt-guard.mjs` → fail-open
  `additionalContext` (never a crash, never a block)
- [ ] After a block, confirm a new line appears in `logs/audit.jsonl` and that
  it contains **no** prompt text — only `ts`, `session_id`, `tier`, `category`.

---

## File layout

```
inverita-guardrail/
  .claude-plugin/
    marketplace.json                   # marketplace manifest (adds this repo as a plugin source)
    plugin.json                        # plugin manifest
  hooks/
    hooks.json                         # registers the UserPromptSubmit hook
    pre-prompt-guard.mjs               # detector + decision + audit log + hook entry point
  cli/
    inverita-guard.mjs                 # `inverita-guard` CLI (guard/check/doctor/serve/install)
  src/                                 # CLI command implementations (importable, unit-tested)
    check.mjs                          #   runCheck()      — detector verdict for a prompt
    doctor.mjs                         #   runDoctor()     — install/wiring health checks
    serve.mjs                          #   createServer()/startServer() — HTTP-hook endpoint
    install.mjs                        #   settings/managed-settings builders + writers
    stdin.mjs                          #   readStream()    — fail-open stream reader (shared)
    config.mjs                         #   resolveMode()   — enforce/advisory mode resolution
  skills/
    guard-selfheal/SKILL.md            # safe diagnose + repair skill (never breaks Claude usage)
  examples/
    .inverita-guard.json               # per-project mode marker template
  test/                                # node:test suites (zero-dependency, 100% coverage)
  managed-settings/
    managed-settings.example.json      # org enforcement template
  package.json                         # `bin: inverita-guard`, `files` allowlist, `npm test`
  logs/.gitkeep                        # audit.jsonl written here at runtime (gitignored)
  README.md
```

### How the code is organized (for contributors)

- **Detection is one file.** All PHI/clinical patterns live in
  `hooks/pre-prompt-guard.mjs` as the exported `LAYER1`, `LAYER2`, and
  `MRN_PATTERNS` config objects, plus the pure `detect()` and
  `processHookInput()` functions. Import them directly in tests — no spawning
  required.
- **The CLI is thin and injectable.** `cli/inverita-guard.mjs` exports an
  `async run(argv, io)` that performs no direct process IO: every stream, env
  var, filesystem home, and the server factory is funnelled through the `io`
  object, and `run()` returns `{ code }` (plus `{ server }` for `serve`) instead
  of touching `process.exitCode`. The module only auto-dispatches when executed
  directly, so tests import `run()` and drive it under any terminal/stdin
  condition in-process. Each subcommand's real work lives in the matching
  `src/*.mjs` module.
