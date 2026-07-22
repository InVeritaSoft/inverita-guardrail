# inverita-guard CLI — Design

**Date:** 2026-07-22
**Status:** Approved for planning
**Repo:** inverita-guardrail

## Problem

The org enforces the PHI guard by registering a managed `UserPromptSubmit` hook
whose command is the bare name `inverita-guard`:

```json
{
  "hooks": { "UserPromptSubmit": [ { "hooks": [ { "type": "command", "command": "inverita-guard", "timeout": 10 } ] } ] },
  "allowManagedHooksOnly": true,
  "strictPluginOnlyCustomization": true
}
```

For that command to resolve and run, a binary named `inverita-guard` must exist
on PATH. Today the guard only exists as `hooks/pre-prompt-guard.mjs` invoked by
the plugin via `$CLAUDE_PLUGIN_ROOT`. This project packages the guard as a
first-class CLI so the managed hook works, and adds operational commands
(testing, coverage detection, an HTTP-hook variant, and self-install).

## Enforcement ceiling (explicit, agreed)

Delivery is **Team plan + admin console only, no MDM**, and the guard stays
**fail-open**. Therefore this is a **strong, un-disableable-in-app default — not
a hard gate**:

- `allowManagedHooksOnly` means a user cannot disable the guard, add a competing
  hook, or edit the policy *inside Claude Code*. ✅
- But the hook runs a **local binary**. Server-managed settings ship config, not
  the binary. A user with control of their machine can uninstall the package (or
  Node, or edit PATH); Claude Code then treats the missing command as a
  **non-blocking error and the prompt proceeds unguarded**. Claude Code hooks
  fail open by design and there is no setting that turns "hook failed" into
  "block".
- Closing that hole needs **device management (MDM)**, which is out of scope.

This matches the plugin's own framing: *defense-in-depth, not a compliance
boundary.* The CLI's job is to make the guard **work and be detectable**, not to
make bypass physically impossible.

## Non-goals (YAGNI)

- **No fail-closed mode.** Fail-open is a deliberate choice; a broken guard must
  not brick developers.
- **No TLS/auth built into `serve`.** Transport security and authentication are
  the deployment's responsibility (front with a reverse proxy inside the
  compliance boundary). Documented, not implemented.
- **No telemetry egress.** The guard stays offline and deterministic; audit
  logging remains local, metadata-only.
- **No registry publish.** Distribution is `npm i -g github:...`; `package.json`
  keeps `private: true`.

## Architecture (Approach A — thin bin + minimal refactor)

Keep the repo's lean, zero-dependency, single-responsibility style.

```
inverita-guardrail/
  bin/
    inverita-guard.mjs        # CLI entry: argv dispatch
  hooks/
    pre-prompt-guard.mjs      # detectors (LAYER1/2, MRN, detect) + exported runHook()
    hooks.json                # unchanged — plugin still calls pre-prompt-guard.mjs
  src/
    doctor.mjs                # doctor checks
    serve.mjs                 # node:http server
    install.mjs               # settings writer / managed-artifact emitter
  test/
    guardrail.test.mjs        # existing detector/hook tests (unchanged behavior)
    cli.test.mjs              # new: bin dispatch, check, doctor, serve, install
```

**Refactor:** extract the current `main()` in `pre-prompt-guard.mjs` into an
exported, side-effect-free-ish `runHook(rawStdin) -> { stdout: string }` (it
still performs best-effort audit logging, but returns the stdout string rather
than writing directly and calling `process.exit`). The file keeps its
direct-invocation block so the plugin's `hooks.json` path is byte-for-byte
unchanged. `bin/inverita-guard.mjs` imports `runHook` for its default mode.

**package.json:** add
`"bin": { "inverita-guard": "bin/inverita-guard.mjs" }`; keep `type: module`,
`engines.node >= 18`, `private: true`. Zero runtime dependencies.

## Commands

Built and reviewed **one at a time**, in this order.

### 1. `inverita-guard` (default — the guard hook)

- Reads the hook JSON payload from stdin, calls `runHook`, writes the decision
  JSON to stdout, exits 0 **always**.
- Output MUST be byte-identical to today's `pre-prompt-guard.mjs`: `block`
  decision, clean `additionalContext`, and the fail-open `additionalContext` on
  unparseable input.
- This is what the managed-settings hook invokes.
- **TTY guard:** if there is no subcommand and stdin is a TTY (not piped), print
  `--help` and exit `0` instead of blocking on a stdin read. Guard mode only
  engages when stdin is piped, which is how Claude Code always invokes it.

### 2. `inverita-guard check "<prompt>"`

- Runs `detect()` on the argument (or on stdin if no arg given and stdin is
  piped).
- Human output: `CLEAN` or `BLOCK  tier=<n>  category=<cat>`.
- `--json` flag: emit `{ "decision": "block"|"clean", "tier", "category" }`.
- **Exit code:** `0` clean, `1` would-block — so it is scriptable for tuning.

### 3. `inverita-guard doctor`

Runs a checklist, prints `PASS`/`FAIL` per item, exits `0` iff all pass (`1`
otherwise). Exit-code driven so MDM/CI/SSH fleet scripts can detect coverage —
the one lever available without MDM.

Checks:
1. Node `>= 18`.
2. `inverita-guard` resolves on PATH.
3. A `UserPromptSubmit` hook wired to `inverita-guard` is present in any
   discoverable settings source (managed paths, `~/.claude/settings.json`,
   project `.claude/settings.json`). Reports which source.
4. Functional smoke test: `detect()` blocks a known-PHI sample and passes a
   known-clean sample.

`--json` flag emits the structured result for aggregation.

### 4. `inverita-guard serve [--port N] [--host H]`

- Zero-dep `node:http` server for the **HTTP-hook** deployment variant.
- `POST` (any path): read the request body as the hook JSON input, run `detect()`
  via the same `decide()` path, respond `200` with the same decision JSON a
  command hook would print.
- `GET /healthz`: `200 {"status":"ok"}`.
- Defaults: `--host 127.0.0.1`, `--port 8787`.
- Prints a startup banner reminding that (a) prompts — possibly containing PHI —
  transit to this endpoint, so it must run inside the compliance boundary, and
  (b) Claude Code fails open on connection error/timeout.

### 5. `inverita-guard install [--managed] [--print]`

- **Default:** merge a `UserPromptSubmit` hook with `command: "inverita-guard"`
  into `~/.claude/settings.json` (the opt-in / self-service path). Idempotent:
  parse existing JSON, add the hook only if an equivalent entry is absent, write
  back preserving other keys. Never clobbers unrelated settings.
- **`--managed`:** do not touch user settings; emit the ready
  `managed-settings.json` (hook + `allowManagedHooksOnly` +
  `strictPluginOnlyCustomization`) for an admin to paste/upload to the console or
  push via MDM.
- **`--print`:** preview the change/artifact to stdout without writing.

### `--version` / `--help`

Standard. `--help` lists subcommands; each subcommand supports `--help`.

## Audit log location (CLI-aware)

`appendAudit` currently writes to `pluginRoot()/logs`. When installed globally
that path may be non-writable. Add a backward-compatible override: the audit dir
resolves to `$INVERITA_GUARD_LOG_DIR` if set, else the existing
`pluginRoot()/logs`. Audit logging remains best-effort and never blocks the
guard. No new default egress; still local, metadata-only.

## Testing

Extend the existing `node:test` suite (zero third-party deps; use
`node:child_process` to spawn the bin, `node:fs`/`node:os` for temp dirs):

- **Parity:** `runHook` and the spawned default bin mode produce byte-identical
  output to the pre-refactor hook for block / clean / fail-open payloads.
- **check:** correct category and exit codes (`0` clean, `1` block); `--json`
  shape.
- **doctor:** passes when wired, fails (exit 1) when a check is unmet; `--json`
  shape.
- **serve:** boot on an ephemeral port, `POST` a PHI sample → `block`, a clean
  sample → clean, `GET /healthz` → ok.
- **install:** writes the hook into a temp settings file, is idempotent on a
  second run, preserves unrelated keys; `--managed`/`--print` emit valid JSON
  without writing user settings.

## Distribution

- Install once per machine: `npm i -g github:InVeritaSoft/inverita-guardrail`
  (npm creates the per-OS PATH shim — `inverita-guard` on Unix,
  `inverita-guard.cmd` on Windows). Runs offline and instantly per prompt
  thereafter.
- Private repo: the installing machine needs Git access/credentials.
- Managed settings (console) already reference the bare `inverita-guard`
  command; no change needed there once the binary is on PATH.

## Documentation

Update `README.md` after implementation: add an "Install the CLI" section, the
`doctor`/coverage-detection workflow, the `serve` HTTP-hook variant with its
egress warning, and restate the enforcement ceiling above.
