# Changelog

All notable changes to **inverita-guardrail** are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.11] — 2026-09-22

### Added
- **Environment awareness** (`src/environment.mjs`) — the guard now identifies
  whether a prompt concerns a developer's local machine or a shared
  dev/stage/prod system, and scales **Layer 2** accordingly: `local` warns even
  under `enforce`, `stage`/`prod` block even under `advisory`, `dev` and
  "no signal" behave exactly as before. **Layer 1 identifiers still block in
  every environment** — no environment, config, or prompt wording can soften
  them.
- **Automatic, zero-config detection** from the prompt text, with
  **stack-neutral** marker tables: .NET, Node, Python, JVM, Go, Ruby, PHP,
  Rust, and container/cloud tooling each have their own table plus a shared
  generic set. Adding an ecosystem is a table entry, not a regex rewrite.
  Escalating markers are checked first, so a prompt naming both prod and
  localhost resolves to prod.
- **Repo heuristics** limited to dev-only artifacts (`.env.local`,
  `appsettings.Development.json`, `launchSettings.json`, `docker-compose.yml`)
  and structurally unable to conclude anything but `local`.
- **`INVERITA_GUARD_ENV`** env var and an `"environment"` key in
  `.inverita-guard.json`, both outranking automatic detection.
- **`inverita-guard check --env <local|dev|stage|prod>`** to force an
  environment, and an informational environment line in `doctor`.

### Changed
- Audit records gain **`environment`** and **`env_source`** fields, so an
  environment-driven block can be explained to a compliance reviewer.
- `check` verdict lines now report the resolved environment and its source.
- `src/config.mjs` grew a shared `findProjectConfig()` walk-up; `readProjectMode`
  and `readProjectExceptions` now build on it rather than duplicating the loop.

### Tests
- 190 tests (up from 141), including the full 3×2 environment/mode action
  matrix, prod-beats-local precedence, the "merely being a checkout is not
  evidence" rule, and per-stack marker coverage for every supported ecosystem.

### Known trade-off
- Relaxation from prompt text is a deliberate, bounded bypass: writing
  "localhost" downgrades Layer 2. Layer 1 is unaffected. Pin
  `{ "environment": "prod" }` in `.inverita-guard.json` to close it — config
  outranks prompt text.

## [0.1.10] — 2026-07-30

### Added
- **`inverita-guard update [--tag vX.Y.Z]`** — reinstalls globally via
  `npm i -g github:InVeritaSoft/inverita-guardrail` (or a pinned tag), then
  automatically re-runs `doctor` to verify the install, including the
  end-to-end dispatch check. Exit 0 only if both the install and the
  post-update health check succeed.

### Tests
- 141 tests, 100% line / branch / function coverage, including a real
  subprocess test that exercises the genuine `spawnSync` wiring against a
  stubbed `npm` on PATH (never touches the real registry).

## [0.1.9] — 2026-07-30

### Added
- **Project exceptions** — a reasoned, Layer-2-only allowlist for recurring
  false positives (e.g. a pharmacy app that legitimately discusses medication
  doses). New CLI: `inverita-guard exceptions list|add|remove`. `add` requires
  `--reason` and writes `{ category, reason }` to `.inverita-guard.json` in
  the current directory; `inverita-guard check` now also reports an
  `EXCEPTED` verdict when a category is excepted.
- `src/categories.mjs` — single source of truth for Layer-1/Layer-2 category
  ids, used to validate exceptions.
- `guard-selfheal` skill gained a "Step 2b" for safely adding an exception on
  a developer's behalf, always via the CLI and always Layer-2-only.

### Security
- **Exceptions can never reach Layer 1.** The CLI refuses to add a Layer-1
  category (SSN/MRN/DOB/email+clinical/insurance) outright. Independently,
  the guard's *read* path filters every `exceptions` entry against the
  Layer-2 category list — so even a hand-edited or malicious config naming a
  Layer-1 category is silently dropped and has no effect. This is a
  structural guarantee, not just a write-time check.

### Tests
- 135 tests, 100% line / branch / function coverage, including the read-side
  Layer-1 rejection and end-to-end CLI verification.

## [0.1.8] — 2026-07-28

### Fixed
- **Silent no-op on global npm installs.** Direct-invocation dispatch compared
  `import.meta.url` to `pathToFileURL(process.argv[1])`. `npm i -g` installs the
  bin as a symlink and Node loads the module via its realpath, so the two never
  matched — `run()` never fired and **every subcommand exited 0 printing
  nothing**. Because the wired hook command (bare `inverita-guard`) was itself
  the no-op, the guard **failed open on every prompt**. Dispatch now resolves
  `realpathSync(process.argv[1])` before comparing. Reported by a macOS user
  following the README.

### Added
- **End-to-end `doctor` check.** `inverita-guard doctor` now actually executes
  the resolved CLI in guard mode against a synthetic-PHI probe and confirms it
  returns a `block` decision. A presence-only (substring) wiring check could
  show green over a dead guard; this catches a silent-dispatch regression.
- Exported, tested `isInvokedDirectly()` helper (symlink / missing-path /
  imported-as-module coverage).

### Tests
- 102 tests, 100% line / branch / function coverage.

## [0.1.7] — 2026-07-28

### Added
- **Project-scoped enforcement modes** (`enforce` / `advisory`). Layer 1
  identifiers (SSN/MRN/DOB/…) hard-block in every mode; the broad Layer 2
  clinical net blocks in `enforce` and only warns in `advisory`. Mode resolves
  from `INVERITA_GUARD_MODE`, then the nearest `.inverita-guard.json` walking up
  from the repo (`{"mode":…}` or `{"healthcare":true}`), else the `advisory`
  default.

## [0.1.6] — 2026-07-28

### Added
- **`guard-selfheal` skill** — safe, read-only-first diagnosis and additive,
  idempotent repair of the guard wiring. Never edits managed settings, never
  removes a developer's own MCP/hooks/skills/agents, never adds
  `strictPluginOnlyCustomization`.

## [0.1.5] — 2026-07-28

### Fixed
- **Stopped breaking user MCP.** Dropped `strictPluginOnlyCustomization` from the
  default managed settings — that flag disables developers' own user/project MCP
  servers, skills, and agents. Enforcement is preserved by `allowManagedHooksOnly`
  alone. (Root cause of a Windows 11 user's "MCP stopped working" report.)

## [0.1.4]

### Changed
- Reached 100% test coverage; made the CLI injectable/testable via
  `run(argv, io)`; developer-facing README.

## [0.1.3]

### Fixed
- Block decisions no longer silently drop user feedback; use `process.exitCode`
  instead of `process.exit()` so piped stdout is not truncated.

## [0.1.2]

### Changed
- Added an npm `files` allowlist to trim the published package.

## [0.1.1]

### Changed
- Version bump.

## [0.1.0]

### Added
- Initial release: PHI-safety `UserPromptSubmit` guard packaged as the
  `inverita-guard` CLI, with a plugin marketplace and managed-settings
  enforcement path.

[0.1.10]: https://github.com/InVeritaSoft/inverita-guardrail/releases/tag/v0.1.10
[0.1.9]: https://github.com/InVeritaSoft/inverita-guardrail/releases/tag/v0.1.9
[0.1.8]: https://github.com/InVeritaSoft/inverita-guardrail/releases/tag/v0.1.8
[0.1.7]: https://github.com/InVeritaSoft/inverita-guardrail/releases/tag/v0.1.7
[0.1.6]: https://github.com/InVeritaSoft/inverita-guardrail/releases/tag/v0.1.6
[0.1.5]: https://github.com/InVeritaSoft/inverita-guardrail/releases/tag/v0.1.5
[0.1.4]: https://github.com/InVeritaSoft/inverita-guardrail/releases/tag/v0.1.4
[0.1.3]: https://github.com/InVeritaSoft/inverita-guardrail/releases/tag/v0.1.3
[0.1.2]: https://github.com/InVeritaSoft/inverita-guardrail/releases/tag/v0.1.2
[0.1.1]: https://github.com/InVeritaSoft/inverita-guardrail/releases/tag/v0.1.1
[0.1.0]: https://github.com/InVeritaSoft/inverita-guardrail/releases/tag/v0.1.0
