# inverita-guardrail

A force-enabled Claude Code plugin that runs a **mandatory PHI-safety check on
every prompt** for the PixelCare Health project. It blocks prompts that look
like they contain protected health information (PHI) or unnecessary clinical
specifics *before they reach Claude*, and it is designed to be deployed
**org-wide** so individual developers cannot disable or bypass it.

> [!IMPORTANT]
> This is a **client-side filter**, not a compliance boundary. It reduces
> *accidental* PHI exposure in prompts. It is **not** a substitute for a
> BAA and HIPAA-compliant upstream data pipeline. **Real PHI must never be
> typed into any prompt, regardless of this guard.**

---

## What it does

On every prompt (`UserPromptSubmit` hook, no matcher — fires on all prompts):

| Tier | What it catches | Confidence | Action |
|------|-----------------|------------|--------|
| **Layer 1 — identifiers** | SSNs, MRN/patient-ID tokens, DOB next to a name, email + clinical terms, insurance/policy numbers | High | **Block** |
| **Layer 2 — clinical specifics** | ICD-code-shaped tokens, medication + dosage, lab/vital values, clinical-narrative phrasing, age + condition | Lower / broad net | **Block** (strict posture) |
| No match | — | — | Allow + inject a "healthcare context, synthetic data only" reminder |

Both tiers block by default. The **reason message names the tier and category**
(`identifier: ssn_pattern` vs `clinical specificity: medication_dosage`) so
developers can self-correct quickly, and Layer 2 blocks are framed as
"clinical specificity" (non-shaming, likely-false-positive-aware) rather than
"you leaked PHI".

If the hook cannot read its input payload, it **fails open with a warning**
(injects a context note that the check was skipped) rather than bricking the
prompt — a deliberate choice so a future input-schema change can't wedge every
developer's Claude Code.

### Audit log

Every block appends one JSON line to `logs/audit.jsonl`:

```json
{"ts":"2026-07-14T09:15:22.104Z","session_id":"abc123","tier":1,"category":"ssn_pattern"}
```

- **Metadata only.** It records timestamp, session id, tier, and category —
  **never the matched text or the original prompt.**
- **Local only.** Nothing is transmitted anywhere. The org's compliance
  reviewer pulls it manually from the developer's machine.
- **Capped + rotated.** At 5 MB, `audit.jsonl` is rotated to `audit.jsonl.1`
  (a single previous generation, overwritten on the next rotation).
- The log is git-ignored. Note that **this log is itself metadata that may be
  subject to your internal data-handling policy** (it reveals when/how often a
  developer tripped the guard) — treat and retain it accordingly.

---

## Force-install (for admins)

Enforcement has two parts: (1) make the plugin available from your org
marketplace, and (2) force-enable it via **managed settings**.

### 1. Publish the plugin to your org marketplace

Host this plugin in your organization's Claude Code plugin marketplace (named
`inverita` in the examples here) so it resolves as `inverita/inverita-guardrail`.

### 2. Deliver managed settings

Copy `managed-settings/managed-settings.example.json`, **remove the
`_comment_*` documentation keys**, and deliver it as managed settings via
**one** of:

**Option A — Team/Enterprise admin console (refreshes ~hourly).**
Configure the managed settings in the Claude admin console and assign them to
the PixelCare Health workspace/users. If a developer edits their local
settings, the managed policy is re-applied on the next (~hourly) refresh.
Best when you manage users through the Anthropic console and don't run device
management.

**Option B — MDM-pushed file at a system-level path (recommended for hard
enforcement).** Push the file via your MDM (Jamf, Intune, …) to the
OS system path:

| OS | Path |
|----|------|
| macOS | `/Library/Application Support/ClaudeCode/managed-settings.json` |
| Linux | `/etc/claude-code/managed-settings.json` |
| Windows | `C:\ProgramData\ClaudeCode\managed-settings.json` |

These paths are **root/administrator-owned and not user-writable**, so a
developer-level session cannot edit or delete them to bypass the guard.

> [!WARNING]
> Do **not** place the managed settings in `~/.claude/`. That path is
> **user-writable and therefore bypassable** — a developer could simply edit or
> delete it. Managed enforcement requires a path the developer cannot write to
> (admin console delivery or a system-level MDM-pushed file).

### Managed settings contents

```json
{
  "enabledPlugins": ["inverita/inverita-guardrail"],
  "allowManagedHooksOnly": true
}
```

---

## Why `allowManagedHooksOnly` is required for real enforcement

`enabledPlugins` in managed settings force-*enables* the plugin. But hooks can
also be registered from user (`~/.claude/settings.json`) and project
(`.claude/settings.json`) scopes. Without an additional control, a developer
could register their own competing `UserPromptSubmit` hook, or otherwise
interfere with hook execution.

`"allowManagedHooksOnly": true` tells Claude Code to execute **only** hooks that
originate from **managed settings / managed plugins** and to ignore hooks
defined in user or project settings. This makes the guardrail hook the single
authoritative `UserPromptSubmit` hook.

**This flag is the line between "recommended" and "enforced."** Enabling the
plugin without it means the guard runs, but the developer's own hooks run too
and the setup is not tamper-resistant. With both the managed `enabledPlugins`
entry *and* `allowManagedHooksOnly`, there is no developer-level way to silently
opt out.

There is deliberately **no bypass flag, no debug env var that disables the
hook, and no local per-developer override** anywhere in this plugin.

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

## Testing checklist

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
  .claude-plugin/plugin.json           # plugin manifest
  hooks/hooks.json                     # registers the UserPromptSubmit hook
  hooks/pre-prompt-guard.mjs           # detection + decision + audit logging
  managed-settings/
    managed-settings.example.json      # org enforcement template
  logs/.gitkeep                        # audit.jsonl written here at runtime (gitignored)
  README.md
```
