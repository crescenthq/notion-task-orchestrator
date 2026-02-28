# PRD: NotionFlow Hard-Reset Cleanup for Library-First Architecture

## 1. Introduction/Overview

NotionFlow has already completed the architectural switch from global CLI state to a project-local, library-first model. Core implementation and tests are largely in place, but repository ergonomics still include legacy assumptions from the previous generation (global setup/config commands, skill instructions that reference `~/.config/notionflow`, and examples that are not packaged as fully standalone projects).

This PRD defines a cleanup phase that removes previous-version residue and standardizes the repository around one model only:

- project-local runtime (`.notionflow/`),
- explicit `notionflow.config.ts`-based factory loading,
- typed package imports for authoring,
- examples and skills that match current behavior.

This is a hard reset cleanup. No migration path, compatibility shims, or dual-mode behavior are required.

## 2. Goals

- Remove remaining product surface that implies legacy global mode.
- Ensure CLI help and command set communicate a single local-project + library-first workflow.
- Rewrite local repo skills (`skills/`) so generated guidance cannot instruct deprecated commands or paths.
- Convert examples into standalone, runnable project packages with their own metadata and scripts.
- Ensure docs, skills, examples, and CLI output are internally consistent.
- Add automated checks that prevent regressions to global-path guidance and deprecated commands.

## 3. User Stories

### US-001: Remove legacy global-first commands from the baseline experience
**Description:** As a new user, I want CLI help to show only relevant local-project commands so I am not misled by deprecated setup patterns.

**Acceptance Criteria:**
- [ ] Top-level help output no longer presents legacy-first commands (`setup`, `config`, `board`) as primary onboarding path.
- [ ] Legacy onboarding commands (`setup`, `config`, `board`) are removed from the CLI surface (unknown command at runtime).
- [ ] CLI description/version messaging reflects library-first positioning.
- [ ] `npm run check` passes.
- [ ] `npm run test` passes for touched CLI tests.

### US-002: Make local project quickstart the only documented path
**Description:** As a user, I want every doc entrypoint to guide the same quickstart so I can onboard without guessing.

**Acceptance Criteria:**
- [ ] `README.md` and CLI docs present one canonical sequence: `init` -> `factory create` -> `doctor` -> `tick`.
- [ ] No docs instruct editing/installing workflows under `~/.config/notionflow`.
- [ ] No docs reference removed command `factory install`.
- [ ] Docs explain `--config <path>` and walk-up discovery consistently.
- [ ] `npm run test:e2e -- e2e/local-project-docs-quickstart-live.test.ts` passes.

### US-003: Rewrite local skills for current architecture
**Description:** As a user invoking local NotionFlow skills, I want generated guidance to match current CLI/runtime behavior.

**Acceptance Criteria:**
- [ ] `skills/setup/SKILL.md` is rewritten to local-project architecture and removes global-path/config-file instructions.
- [ ] `skills/add-factory/SKILL.md` replaces `factory install` flow with explicit config declaration flow.
- [ ] Skills reference runtime helpers and package imports consistent with current API (`defineConfig`, `defineFactory`, helper exports).
- [ ] Each skill includes at least one command example validated against current CLI behavior.
- [ ] `npm run check` passes.

### US-004: Convert examples into standalone project packages
**Description:** As a developer, I want each example project to be independently runnable so examples are copy-pasteable and testable in isolation.

**Acceptance Criteria:**
- [ ] `example-factories/` includes its own `package.json` with scripts for `doctor`, `tick`, and example smoke flow.
- [ ] Example package declares required peer/runtime assumptions (Node version, env vars, and how to invoke local/installed NotionFlow).
- [ ] Example README provides exact setup and run commands from a clean checkout.
- [ ] Example structure remains local-project compliant (`notionflow.config.ts`, `factories/`, optional shared helpers).
- [ ] Example package scripts run successfully in CI/dev verification scope.

### US-005: Add consistency guardrails for hard-reset mode
**Description:** As a maintainer, I want automated checks that fail on legacy wording so the repo cannot drift back to global guidance.

**Acceptance Criteria:**
- [ ] Add a docs/skills lint check (script or test) that fails on forbidden legacy patterns: `~/.config/notionflow` workflow editing/install guidance and `factory install` usage.
- [ ] Add assertions that canonical docs and skill files include required local-project terms (`notionflow.config.ts`, `.notionflow/`, `--config`).
- [ ] Integrate this check into CI command set (`npm run test` or dedicated script invoked by CI).
- [ ] Failure output lists file path and offending line/snippet.

### US-006: Align package positioning with library-first authoring
**Description:** As an integrating developer, I want package metadata and entrypoints to emphasize import-based usage in addition to CLI usage.

**Acceptance Criteria:**
- [ ] Package metadata (`description`, relevant keywords/README intro) emphasizes typed library-first API.
- [ ] Public API docs include minimal import example from package root and local project config usage.
- [ ] Export surface documentation stays synchronized with `src/index.ts` contract tests.
- [ ] `npm run test -- src/index.test.ts` passes.

### US-007: Final hard-reset release checklist and sign-off
**Description:** As a maintainer, I want a release readiness checklist proving global mode residue is removed so the release is safe to communicate as a reset.

**Acceptance Criteria:**
- [ ] Create a release checklist document for hard-reset validation.
- [ ] Checklist includes: docs audit, skills audit, examples audit, CLI help audit, and no global-write assertions.
- [ ] Checklist links exact verification commands and expected outputs.
- [ ] Checklist is executed once with results captured before release tag.

## 4. Functional Requirements

- FR-1: The CLI surface must present local-project workflow as the default and only recommended onboarding flow.
- FR-2: Legacy onboarding commands (`setup`, `config`, `board`) must be removed from the CLI surface.
- FR-3: Repository docs must not instruct writing factories or runtime artifacts under `~/.config/notionflow`.
- FR-4: Repository docs must not reference `factory install` as an operational step.
- FR-5: Local skill files under `skills/` must align with current command semantics and paths.
- FR-6: Example projects must be runnable as standalone packages with local scripts and required metadata.
- FR-7: Example README instructions must be executable from a clean clone without hidden global prerequisites.
- FR-8: The repository must include automated legacy-pattern detection for docs/skills content.
- FR-9: Legacy-pattern checks must report actionable diagnostics including file path and offending text.
- FR-10: Library-first API usage must be visible in top-level package messaging and docs.
- FR-11: Export-surface documentation must match actual root exports and associated API contract tests.
- FR-12: Hard-reset release sign-off must include objective evidence that global workflow guidance is removed.

## 5. Non-Goals (Out of Scope)

- No migration assistant for users of old global config/workflow locations.
- No compatibility guarantee for old `setup`-driven onboarding flows.
- No restoration of `factory install` behavior.
- No redesign of runtime state machine semantics.
- No expansion of Notion integration features beyond cleanup alignment.

## 6. Design Considerations

- Keep command docs and skill instructions terse and imperative, optimized for copy/paste execution.
- Treat `notionflow.config.ts` as the canonical center of project structure examples.
- Prefer “single source of truth” snippets reused across README/docs/skills to avoid drift.
- Example projects should feel production-like, not fixture-like.

## 7. Technical Considerations

- CLI command visibility changes may require updates to command registration tests and help snapshots.
- Skill updates are content-only but high impact because they steer downstream generated instructions.
- Example packaging should avoid circular dependency pitfalls when referencing local workspace package versus npm package.
- Legacy-pattern linting can be implemented as a lightweight test that scans targeted docs/skills paths for forbidden tokens.

## 8. Success Metrics

- Zero references to `factory install` in user-facing docs and local skills.
- Zero user-facing guidance to edit or install workflows under `~/.config/notionflow`.
- Example project runs from its own directory using documented scripts with no hidden setup.
- CI includes at least one automated legacy-pattern guardrail check.
- A new contributor can complete the documented local quickstart in under 10 minutes.

## 9. Open Questions

- Should standalone example packages pin a published `notionflow` version, or reference workspace source during development?
- Do we want one canonical example project or multiple package-scoped examples by use case?
- Should legacy-pattern linting also scan external docs (website/docs repo) in the same CI pass?

## 10. Delivery Plan (Ralph-Ready Tickets)

### NLC-001: CLI Surface Cleanup
**Goal:** Remove legacy-first command posture from CLI help and onboarding output.

**Tasks:**
- [ ] Audit `src/cli.ts` command registration and help text for legacy-first posture.
- [ ] Remove legacy onboarding commands (`setup`, `config`, `board`) from baseline CLI flow.
- [ ] Update CLI tests/snapshots for help output.

**Verifiable Requirements:**
- [ ] `notionflow --help` communicates local-project baseline commands.
- [ ] No help text suggests global setup as primary path.
- [ ] `notionflow setup`, `notionflow config`, and `notionflow board` return unknown command errors.
- [ ] `npm run check` passes.
- [ ] `npm run test` passes for touched tests.

### NLC-002: Docs Canonicalization for Hard Reset
**Goal:** Ensure docs show only current architecture and command sequence.

**Tasks:**
- [ ] Audit and update `README.md` and docs under `docs/`.
- [ ] Remove legacy references to global workflow paths and install command.
- [ ] Normalize wording for config discovery and `--config` usage.

**Verifiable Requirements:**
- [ ] Canonical quickstart appears in docs entrypoints.
- [ ] Forbidden legacy terms are absent from docs.
- [ ] `npm run test:e2e -- e2e/local-project-docs-quickstart-live.test.ts` passes.

### NLC-003: Skill File Hard-Reset Alignment
**Goal:** Update local skills so generated guidance is architecture-correct.

**Tasks:**
- [ ] Rewrite `skills/setup/SKILL.md`.
- [ ] Rewrite `skills/add-factory/SKILL.md`.
- [ ] Add examples that use explicit config declarations and local project structure.

**Verifiable Requirements:**
- [ ] No legacy command/path guidance remains in local skill files.
- [ ] Skill command snippets match current CLI behavior.
- [ ] Review pass confirms consistency with docs quickstart.

### NLC-004: Standalone Example Packaging
**Goal:** Make examples independently runnable and trustworthy.

**Tasks:**
- [ ] Add `example-factories/package.json` and scripts.
- [ ] Add any required config for local typecheck/test execution in example directory.
- [ ] Update example README for exact standalone run steps.

**Verifiable Requirements:**
- [ ] Example can run documented scripts from example directory.
- [ ] Example README reflects actual script names and env requirements.
- [ ] Example remains local-project architecture compliant.

### NLC-005: Legacy-Pattern Guardrail Automation
**Goal:** Prevent regressions to deprecated global guidance.

**Tasks:**
- [ ] Add a test/script scanning docs + skills for forbidden patterns.
- [ ] Add required-pattern assertions for local-project terminology.
- [ ] Integrate into CI-run command.

**Verifiable Requirements:**
- [ ] Introducing a forbidden pattern causes deterministic CI failure.
- [ ] Failure output points to exact file/snippet.
- [ ] `npm run check` and guardrail command pass on clean branch.

### NLC-006: Hard-Reset Release Checklist and Evidence Capture
**Goal:** Produce a concrete sign-off artifact for release readiness.

**Tasks:**
- [ ] Add checklist document under `tasks/`.
- [ ] Execute validation commands and capture results.
- [ ] Mark completion with date and owner.

**Verifiable Requirements:**
- [ ] Checklist exists and references command outputs.
- [ ] All cleanup tickets mapped to checklist rows.
- [ ] Release gate can be reviewed asynchronously.
