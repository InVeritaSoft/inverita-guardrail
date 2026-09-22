#!/usr/bin/env node
/**
 * inverita-guardrail :: pre-prompt-guard
 * --------------------------------------
 * UserPromptSubmit hook for the PixelCare Health project.
 *
 * Reads the prompt payload from stdin and decides whether the prompt may
 * proceed. It blocks prompts that look like they contain PHI (Layer 1,
 * high-confidence identifiers) or unnecessary clinical specifics (Layer 2,
 * broad net). On a clean prompt it injects a context reminder that this is a
 * healthcare-data project requiring synthetic/anonymized data only.
 *
 * Design notes:
 *  - Node stdlib only, zero dependencies.
 *  - Deterministic, offline, no network. Nothing leaves this machine.
 *  - `LAYER1`, `LAYER2`, and `MRN_PATTERNS` are exported so a test harness (or
 *    the compliance owner) can import and tune them without running the hook.
 *  - This is a CLIENT-SIDE FILTER, not a compliance boundary. It reduces
 *    accidental PHI exposure; it is NOT a substitute for BAA/HIPAA-compliant
 *    upstream handling. Real PHI must never be typed into any prompt.
 *
 * Hook I/O contract (Claude Code UserPromptSubmit):
 *  - Block:  print {"decision":"block","reason":"..."} to stdout, exit 0.
 *  - Clean:  print {"hookSpecificOutput":{"hookEventName":"UserPromptSubmit",
 *            "additionalContext":"..."}} to stdout, exit 0.
 *  - stdout MUST contain only that JSON. Diagnostics (if any) go to stderr.
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readStream } from '../src/stdin.mjs';
import { resolveMode, resolveExceptionCategories } from '../src/config.mjs';
import { resolveEnvironment, isRelaxed, isStrict, UNKNOWN } from '../src/environment.mjs';
import {
  containsOverridePhrase,
  isOverrideEnabled,
  grantOverride,
  isOverrideActive,
  overrideRemainingMs,
} from '../src/override.mjs';

/* ------------------------------------------------------------------ *
 * Configuration
 * ------------------------------------------------------------------ */

const PLUGIN_NAME = 'inverita-guardrail';

// Cap the audit log and keep a single rotated generation (audit.jsonl.1).
const MAX_LOG_BYTES = 5 * 1024 * 1024; // 5 MB

const CLEAN_CONTEXT =
  'Reminder (inverita-guardrail): PixelCare Health is a healthcare-data project. ' +
  'Use only synthetic or fully anonymized data in prompts, code, tests, and examples — ' +
  'never real patient PHI such as names, MRNs, dates of birth, SSNs, insurance/policy ' +
  'numbers, or real clinical narratives.';

const FAILOPEN_CONTEXT =
  '[inverita-guardrail] The prompt payload could not be read, so the PHI pre-check was ' +
  'skipped for this message. Treat this as a healthcare-data context: assume ' +
  'synthetic/anonymized data only and neither request nor emit any real PHI.';

/**
 * Advisory-mode caution for a Layer 2 match: the prompt is allowed through, but
 * the model is told what tripped the broad clinical net so it can steer the
 * developer toward synthetic data without blocking legitimate work.
 */
function buildWarnContext(hit, env) {
  if (isRelaxed(env.environment)) {
    return (
      `[${PLUGIN_NAME}] Advisory (environment: ${env.environment}${describeSource(env)}) — clinical ` +
      `specificity detected (category: ${hit.category}), not blocked. ${hit.body}\n` +
      'This prompt looks like local development work, so Layer 2 is a caution rather than a ' +
      'block. Real PHI must still never be entered — Layer-1 identifiers (SSN/MRN/DOB) are ' +
      'blocked in every environment.'
    );
  }
  return (
    `[${PLUGIN_NAME}] Advisory (mode: advisory) — clinical specificity detected ` +
    `(category: ${hit.category}), not blocked. ${hit.body}\n` +
    'Use synthetic or fully anonymized data; this project is not in enforce mode, so ' +
    'this is a caution rather than a block.'
  );
}

/**
 * Context injected when a break-glass override lets a detected prompt through.
 * The model is told explicitly that a human attested — not that the prompt is
 * clean — so it keeps treating the material as sensitive.
 */
function buildOverrideContext(hit, minutesLeft) {
  return (
    `[${PLUGIN_NAME}] OVERRIDDEN — a detection fired (tier ${hit.tier}, category: ${hit.category}) ` +
    'but the developer attested that this prompt contains no real PHI, so it was allowed ' +
    `through. This unlock is session-scoped and expires in ~${minutesLeft} minute(s).\n` +
    'The attestation is a human claim, not a clean scan: treat this material as sensitive, ' +
    'do not echo identifiers back, and continue to use synthetic or fully anonymized data.'
  );
}

/**
 * Appended to a block when the developer typed the attestation but the org has
 * switched the override off. Silence here would look like the phrase failed.
 */
function buildOverrideDisabledNote() {
  return (
    '\n\nNote: this machine has the break-glass override disabled by policy ' +
    '(INVERITA_GUARD_ALLOW_OVERRIDE=0), so the attestation phrase has no effect here. ' +
    'Remove the flagged content or contact the compliance owner.'
  );
}

/** Human-readable provenance for an environment decision, for audit clarity. */
function describeSource(env) {
  if (env.source === 'default') return '';
  if (env.marker) return `, from ${env.source}: "${env.marker}"`;
  return `, from ${env.source}`;
}

/**
 * Appended to a Layer-2 block that happened because of the environment rather
 * than the project's mode. Without this the developer sees a block their
 * `.inverita-guard.json` says should have been a warning.
 */
function buildEscalationNote(env) {
  return (
    `\n\nEscalated: this prompt reads as a ${env.environment} environment` +
    `${describeSource(env)}, where real PHI is most likely to exist. Layer 2 blocks there ` +
    'regardless of this project\'s advisory mode. If this prompt is really about local or ' +
    'synthetic data, say so explicitly and resubmit.'
  );
}

/**
 * A Layer-2 hit that this project has an approved, reasoned exception for
 * (`.inverita-guard.json` → `exceptions`). Layer 1 identifiers can never reach
 * this path — see resolveExceptionCategories / readProjectExceptions.
 */
function buildExceptionContext(hit) {
  return (
    `[${PLUGIN_NAME}] Exception applied (category: ${hit.category}) — allowed for this project ` +
    `per .inverita-guard.json, not blocked. ${hit.body}\n` +
    'This project has an approved, reasoned exception for this Layer-2 category. Real PHI must ' +
    'still never be entered; Layer-1 identifiers (SSN/MRN/DOB/etc.) are never exceptable.'
  );
}

/* ------------------------------------------------------------------ *
 * MRN / patient-identifier patterns (exported for per-EHR tuning)
 * ------------------------------------------------------------------ *
 * MRN formats vary by EHR (Epic, Cerner, Meditech, ...). These defaults key
 * on a label followed by a LONG digit run (>= 5 digits), because real MRNs are
 * typically 6-10+ digits. Short synthetic IDs like `PT-0001` (<= 4 digits) are
 * intentionally NOT matched — that is the recommended replacement, so blocking
 * it would punish good behavior.
 *
 * If your EHR emits unlabeled MRNs, add a bare pattern here — but beware false
 * positives on order numbers, ticket IDs, and other long numeric tokens.
 */
export const MRN_PATTERNS = [
  // "MRN: 00123456", "MRN #12345678", "mrn-987654"
  /\bMRN\b\s*[:#-]?\s*\d{5,}\b/i,
  // "medical record number: 000123456", "patient id ABC1234567"
  /\b(?:medical\s+record\s+(?:number|no\.?|#)|patient\s+(?:id|identifier))\s*[:#-]?\s*[A-Za-z-]*\d{5,}[A-Za-z0-9-]*\b/i,
];

/* ------------------------------------------------------------------ *
 * Shared detection primitives
 * ------------------------------------------------------------------ */

const SSN_RE = /\b\d{3}-\d{2}-\d{4}\b/;
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/;
const EMAIL_CLINICAL_TERM_RE = /\b(?:patient|diagnosis|dx)\b/i;

const DATE_RE = /\b(?:\d{1,2}[/-]\d{1,2}[/-]\d{2,4}|\d{4}-\d{2}-\d{2})\b/;
const NAME_SHAPED_RE = /\b[A-Z][a-z]+\s+[A-Z][a-z]+\b/;
const DOB_LABEL_RE = /\b(?:d\.?o\.?b\.?|date of birth|born(?:\s+on)?)\b/i;

const INSURANCE_RE =
  /\b(?:policy|member|subscriber|insurance|group|plan)\s*(?:number|no\.?|#|id)?\s*[:#-]?\s*([A-Za-z0-9][A-Za-z0-9-]{5,})\b/i;

// Layer 2 primitives
const ICD_RE = /\b[A-TV-Z]\d{2}(?:\.\d{1,4})?\b/;

const DOSE_RE = /\b\d+(?:\.\d+)?\s?(?:mg|mcg|µg|ug|ml|units?|iu|tabs?|tablets?)\b/i;
const FREQ_RE =
  /(?:\b\d+\s?x\s?(?:a\s+)?(?:day|daily|week|weekly)\b|\b(?:once|twice|thrice|three times|four times)\s+(?:a\s+)?(?:day|daily|week|weekly)\b|\bq\.?\s?\d+\s?h(?:ours?)?\b|\b(?:bid|tid|qid|qhs)\b)/i;

const LAB_UNIT_RE =
  /\b\d+(?:\.\d+)?\s?(?:mg\/dl|mmol\/l|mmhg|g\/dl|meq\/l|iu\/l|u\/l|ng\/ml|pg\/ml|mcg\/dl|cells\/mcl|beats\/min|bpm)\b/i;
const LAB_TERM_RE =
  /\b(?:blood pressure|glucose|hba1c|a1c|cholesterol|ldl|hdl|triglycerides?|wbc|rbc|hgb|hemoglobin|hematocrit|creatinine|egfr|bun|sodium|potassium|spo2|o2 sat|heart rate|temperature|bmi|inr|tsh|troponin)\b/i;

const NARRATIVE_RE =
  /\b(?:patient (?:presented|presents) with|presented with|presents with|chief complaint|c\/o|complains of|history of present illness|hpi|past medical history|pmh|review of systems|on (?:physical )?exam|discharge summary|admitted (?:for|with)|status[- ]post|s\/p)\b/i;
const HISTORY_OF_RE = /\bhistory of\b/gi;
// "history of" is the highest-FP marker ("git history of", "history of this
// bug"), so it only trips when a clinical companion term is nearby.
const CLINICAL_COMPANION_RE =
  /\b(?:diabetes|diabetic|hypertension|htn|cancer|carcinoma|copd|asthma|stroke|myocardial|depression|anxiety|smoking|alcohol|cad|chf|ckd|seizures?|migraines?|arthritis|surgery|surgical|infection|disease|disorder|syndrome|illness|psychiatric|substance)\b/i;

const AGE_TOKEN_RE =
  /\b(\d{1,3})\s?-?\s?(?:y\.?o\.?|y\/o|years?[\s-]old|year[\s-]old|yo|yof|yom)\b/gi;
const AGE_CONTEXT_RE = /\bwith\b|\bpresent|\bdiagnos|\bmale\b|\bfemale\b/i;

/**
 * True when a date appears within `window` chars of a DOB label or a
 * name-shaped token — i.e. a date of birth attached to a person.
 */
function dobNameProximity(text, window = 40) {
  const re = new RegExp(DATE_RE.source, 'g');
  let m;
  while ((m = re.exec(text)) !== null) {
    const start = Math.max(0, m.index - window);
    const end = Math.min(text.length, m.index + m[0].length + window);
    const slice = text.slice(start, end);
    if (DOB_LABEL_RE.test(slice) || NAME_SHAPED_RE.test(slice)) return true;
  }
  return false;
}

function insuranceMatch(text) {
  const m = INSURANCE_RE.exec(text);
  // Require at least one digit in the captured id to avoid tripping on bare
  // phrases like "policy number required".
  return !!m && /\d/.test(m[1]);
}

function labMatch(text, window = 20) {
  if (LAB_UNIT_RE.test(text)) return true;
  const re = new RegExp(LAB_TERM_RE.source, 'gi');
  let m;
  while ((m = re.exec(text)) !== null) {
    const start = Math.max(0, m.index - window);
    const end = Math.min(text.length, m.index + m[0].length + window);
    if (/\d/.test(text.slice(start, end))) return true;
  }
  return false;
}

function narrativeMatch(text, window = 40) {
  if (NARRATIVE_RE.test(text)) return true;
  const re = new RegExp(HISTORY_OF_RE.source, 'gi');
  let m;
  while ((m = re.exec(text)) !== null) {
    const end = Math.min(text.length, m.index + m[0].length + window);
    if (CLINICAL_COMPANION_RE.test(text.slice(m.index, end))) return true;
  }
  return false;
}

function ageConditionMatch(text, window = 50) {
  const re = new RegExp(AGE_TOKEN_RE.source, 'gi');
  let m;
  while ((m = re.exec(text)) !== null) {
    const age = parseInt(m[1], 10);
    if (Number.isNaN(age) || age > 120) continue;
    const start = Math.max(0, m.index - window);
    const end = Math.min(text.length, m.index + m[0].length + window);
    const slice = text.slice(start, end);
    if (CLINICAL_COMPANION_RE.test(slice) || AGE_CONTEXT_RE.test(slice)) return true;
  }
  return false;
}

/* ------------------------------------------------------------------ *
 * Layer 1 — identifiers (high confidence)
 * ------------------------------------------------------------------ *
 * Each rule: { category, body, match(text) -> boolean }.
 * `body` is the category-specific portion of the block reason; the tier
 * framing and closing guidance are added by buildReason().
 */
export const LAYER1 = [
  {
    category: 'ssn_pattern',
    body:
      'This prompt looks like it contains a Social Security number (###-##-####). ' +
      'Remove it; if you need an example identifier use a synthetic value such as ' +
      '`PT-0001` or a placeholder like `<SSN>`.',
    match: (t) => SSN_RE.test(t),
  },
  {
    category: 'mrn_pattern',
    body:
      'This prompt looks like it contains a medical record number / patient identifier. ' +
      'Replace it with a synthetic patient ID such as `PT-0001` (short synthetic IDs are ' +
      'fine) or a placeholder like `<MRN>`.',
    match: (t) => MRN_PATTERNS.some((re) => re.test(t)),
  },
  {
    category: 'dob_name_proximity',
    body:
      "This prompt has a date of birth next to what looks like a person's name — together " +
      'these can identify a patient. Use a synthetic patient instead, e.g. name `PT-0001`, ' +
      'DOB `1990-01-01`.',
    match: (t) => dobNameProximity(t),
  },
  {
    category: 'email_clinical',
    body:
      'This prompt pairs an email address with clinical terms, which can identify a ' +
      'patient. Use a placeholder address like `patient@example.test` and describe the ' +
      'case generically.',
    match: (t) => EMAIL_RE.test(t) && EMAIL_CLINICAL_TERM_RE.test(t),
  },
  {
    category: 'insurance_policy',
    body:
      'This prompt looks like it contains an insurance or policy number. Replace it with a ' +
      'placeholder such as `<POLICY-ID>`.',
    match: (t) => insuranceMatch(t),
  },
];

/* ------------------------------------------------------------------ *
 * Layer 2 — clinical specifics (broad net, lower confidence)
 * ------------------------------------------------------------------ *
 * Same rule shape as LAYER1. This set is intentionally broad and WILL produce
 * false positives on legitimate non-PHI prompts. It is the primary tuning
 * surface: edit these patterns (or their primitives above) to adjust the net.
 * There is no local per-developer *configuration* override by design; the only
 * bypass is the audited, expiring break-glass attestation in src/override.mjs.
 */
export const LAYER2 = [
  {
    category: 'icd_code',
    body:
      'A token shaped like an ICD diagnosis code (e.g. `E11.9`) was found. If you are ' +
      'referring to a condition generically, name it in plain language without the code.',
    match: (t) => ICD_RE.test(t),
  },
  {
    // Checked before medication_dosage: a concentration like "126 mg/dL" is a
    // lab value, not a dose (bare "126 mg" would otherwise read as a dose).
    category: 'lab_value',
    body:
      'A lab or vital value with a clinical unit was found (e.g. `126 mg/dL`). If it is not ' +
      'patient-specific, drop the exact value or use an obvious placeholder.',
    match: (t) => labMatch(t),
  },
  {
    category: 'medication_dosage',
    body:
      'A medication dose/frequency pattern was found (e.g. `10mg`, `2x daily`). If this is ' +
      "not about a specific patient, describe it generically (e.g. 'a standard maintenance " +
      "dose').",
    match: (t) => DOSE_RE.test(t) || FREQ_RE.test(t),
  },
  {
    category: 'clinical_narrative',
    body:
      "Clinical-narrative phrasing was found (e.g. 'chief complaint', 'history of present " +
      "illness'). If you are not pasting a real record, rephrase without the clinical-note " +
      'framing.',
    match: (t) => narrativeMatch(t),
  },
  {
    category: 'age_condition',
    body:
      'An age combined with a condition was found, which can re-identify individuals in ' +
      "small datasets. Generalize the age (e.g. 'an adult patient') or remove the specific " +
      'condition pairing.',
    match: (t) => ageConditionMatch(t),
  },
];

/* ------------------------------------------------------------------ *
 * Decision
 * ------------------------------------------------------------------ */

function buildReason(tier, category, body) {
  if (tier === 1) {
    return (
      `[${PLUGIN_NAME}] Blocked — identifier detected (category: ${category}).\n\n` +
      `${body}\n\n` +
      'Real PHI must never be entered into any prompt; this project requires synthetic or ' +
      'fully anonymized data only.'
    );
  }
  return (
    `[${PLUGIN_NAME}] Blocked — clinical specificity detected (category: ${category}), ` +
    'not a direct identifier.\n\n' +
    `${body}\n\n` +
    'This PixelCare Health project uses synthetic/anonymized data only. If this is a false ' +
    'positive, reword to remove the specific clinical detail, or ask the compliance owner ' +
    'to tune the Layer-2 regex config (hooks/pre-prompt-guard.mjs → LAYER2). There is no ' +
    'local override.'
  );
}

/**
 * Run all detectors. Returns the first match as
 * { tier, category, reason } or null when the prompt is clean.
 * Layer 1 takes precedence over Layer 2.
 */
/**
 * Given a detection hit and the effective mode, decide the action:
 *  - null  → no hit
 *  - 'block' → Layer 1 always, or Layer 2 under enforce mode
 *  - 'warn'  → Layer 2 under advisory mode (allowed through with a caution)
 */
export function decideAction(hit, mode, environment = UNKNOWN) {
  if (!hit) return null;
  // Layer 1 is a hard floor: no environment, config, or prompt wording can
  // soften a real identifier. This ordering is the safety guarantee.
  if (hit.tier === 1) return 'block';
  // A shared system is where real PHI actually lives — tighten past the
  // project's own mode.
  if (isStrict(environment)) return 'block';
  // A developer's own machine talking about fixtures and seed data is the
  // dominant false-positive source — loosen past the project's own mode.
  if (isRelaxed(environment)) return 'warn';
  return mode === 'enforce' ? 'block' : 'warn';
}

export function detect(prompt) {
  const text = typeof prompt === 'string' ? prompt : '';
  if (!text) return null;
  for (const rule of LAYER1) {
    if (rule.match(text)) {
      return {
        tier: 1,
        category: rule.category,
        body: rule.body,
        reason: buildReason(1, rule.category, rule.body),
      };
    }
  }
  for (const rule of LAYER2) {
    if (rule.match(text)) {
      return {
        tier: 2,
        category: rule.category,
        body: rule.body,
        reason: buildReason(2, rule.category, rule.body),
      };
    }
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Audit logging (local only, metadata only — never raw text)
 * ------------------------------------------------------------------ */

function pluginRoot() {
  if (process.env.CLAUDE_PLUGIN_ROOT) return process.env.CLAUDE_PLUGIN_ROOT;
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
}

function rotateIfNeeded(logFile) {
  try {
    const st = fs.statSync(logFile);
    if (st.size >= MAX_LOG_BYTES) {
      // Single rotated generation; overwrite the previous one.
      fs.renameSync(logFile, `${logFile}.1`);
    }
  } catch {
    /* no existing file yet — nothing to rotate */
  }
}

/**
 * Append one audit record for a block. Records ONLY metadata:
 * timestamp, session_id, tier, category. Never the matched text or prompt.
 * Logging failures are swallowed so they can never break the guard.
 */
export function appendAudit(entry, isoTimestamp) {
  try {
    const dir = process.env.INVERITA_GUARD_LOG_DIR || path.join(pluginRoot(), 'logs');
    const logFile = path.join(dir, 'audit.jsonl');
    fs.mkdirSync(dir, { recursive: true });
    rotateIfNeeded(logFile);
    const record = {
      ts: isoTimestamp,
      session_id: entry.session_id,
      tier: entry.tier,
      category: entry.category,
      mode: entry.mode,
      environment: entry.environment,
      env_source: entry.env_source,
      action: entry.action,
    };
    fs.appendFileSync(logFile, `${JSON.stringify(record)}\n`);
  } catch {
    /* audit logging is best-effort and must never block the guard */
  }
}

/* ------------------------------------------------------------------ *
 * Core business logic (extracted for CLI + hook reuse)
 * ------------------------------------------------------------------ */

function contextOutput(context) {
  return {
    hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: context },
  };
}

/**
 * Decide on a raw stdin payload and return the exact decision JSON to print.
 * Never throws, never exits — fail-open by returning the FAILOPEN context.
 */
export function processHookInput(raw) {
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return { stdout: JSON.stringify(contextOutput(FAILOPEN_CONTEXT)) };
  }
  try {
    const prompt = typeof payload.prompt === 'string' ? payload.prompt : '';
    const sessionId =
      typeof payload.session_id === 'string' && payload.session_id ? payload.session_id : 'unknown';
    const cwd = typeof payload.cwd === 'string' ? payload.cwd : undefined;
    const mode = resolveMode({ cwd, env: process.env });
    const env = resolveEnvironment({ cwd, env: process.env, prompt });

    // Break-glass: the attestation both grants the unlock and applies to the
    // prompt carrying it, so a developer re-submits once rather than twice.
    // Granting is recorded even when the prompt itself is clean.
    const overrideEnabled = isOverrideEnabled(process.env);
    const attested = containsOverridePhrase(prompt);
    if (overrideEnabled && attested) {
      grantOverride(sessionId);
      appendAudit(
        {
          session_id: sessionId,
          tier: null,
          category: 'override_granted',
          mode,
          environment: env.environment,
          env_source: env.source,
          action: 'override_granted',
        },
        new Date().toISOString(),
      );
    }

    const hit = detect(prompt);
    if (hit) {
      // An active unlock outranks every other decision, Layer 1 included. This
      // is the one path that can clear tier 1, and it exists only because a
      // human typed an attestation against this session id.
      if (overrideEnabled && isOverrideActive(sessionId)) {
        appendAudit(
          {
            session_id: sessionId,
            tier: hit.tier,
            category: hit.category,
            mode,
            environment: env.environment,
            env_source: env.source,
            action: 'overridden',
          },
          new Date().toISOString(),
        );
        const minutesLeft = Math.max(1, Math.round(overrideRemainingMs(sessionId) / 60000));
        return { stdout: JSON.stringify(contextOutput(buildOverrideContext(hit, minutesLeft))) };
      }
      const auditBase = {
        session_id: sessionId,
        tier: hit.tier,
        category: hit.category,
        mode,
        environment: env.environment,
        env_source: env.source,
      };
      // Exceptions only ever apply to Layer 2 — a Layer 1 hit reaches
      // decideAction() unconditionally, so identifiers can never be excepted.
      if (hit.tier === 2 && resolveExceptionCategories({ cwd }).has(hit.category)) {
        appendAudit({ ...auditBase, action: 'excepted' }, new Date().toISOString());
        return { stdout: JSON.stringify(contextOutput(buildExceptionContext(hit))) };
      }
      const action = decideAction(hit, mode, env.environment);
      appendAudit({ ...auditBase, action }, new Date().toISOString());
      if (action === 'block') {
        // Explain an environment-driven block; a mode-driven one already reads
        // correctly on its own.
        const escalated = hit.tier === 2 && isStrict(env.environment) && mode !== 'enforce';
        let reason = escalated ? hit.reason + buildEscalationNote(env) : hit.reason;
        // Typing the attestation on a machine where policy removed the override
        // must not fail silently.
        if (attested && !overrideEnabled) reason += buildOverrideDisabledNote();
        return { stdout: JSON.stringify({ decision: 'block', reason }) };
      }
      // Layer 2 allowed through: inject a caution instead of blocking.
      return { stdout: JSON.stringify(contextOutput(buildWarnContext(hit, env))) };
    }
    return { stdout: JSON.stringify(contextOutput(CLEAN_CONTEXT)) };
  } catch {
    return { stdout: JSON.stringify(contextOutput(FAILOPEN_CONTEXT)) };
  }
}

/* ------------------------------------------------------------------ *
 * Hook entry point
 * ------------------------------------------------------------------ */

async function main() {
  // readStream never rejects — it resolves with whatever it has on 'error'.
  const raw = await readStream(process.stdin);
  const { stdout } = processHookInput(raw);
  // Do NOT call process.exit() here. process.exit() does not wait for a
  // stdout write to drain when stdout is a pipe (always true when Claude
  // Code spawns this hook) — if the write is buffered (backpressure), the
  // decision JSON, including the user-facing `reason` on a block, can be
  // silently dropped. Setting exitCode and letting Node exit naturally once
  // the event loop is empty guarantees the write completes first.
  process.stdout.write(stdout);
  process.exitCode = 0;
}

// Only run the hook when executed directly (so tests can import the detectors).
const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main();
}
