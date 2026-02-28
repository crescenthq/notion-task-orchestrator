# Hard-Reset Cleanup Release Checklist

Branch: `ralph/hard-reset-library-first-cleanup`
Date executed: 2026-02-28

---

## 1. CLI Help Audit

**Verification command:**
```
npx tsx src/cli.ts --help
```

**Expected:** Description says "Library-first, project-local"; commands list is `init|doctor|tick|run|status|factory|integrations`; no `setup`, `config`, or `board` in USAGE or COMMANDS.

**Result (PASS):**
```
Library-first, project-local orchestration CLI (notionflow v0.1.0)

USAGE notionflow init|doctor|tick|run|status|factory|integrations

COMMANDS

          init    [common] Initialize a local NotionFlow project
        doctor    [common] Validate NotionFlow setup and integration auth
          tick    [common] Run one orchestration tick across queued tasks
           run    [common] Run a factory for one task
        status    [common] Show task status from local SQLite
       factory    [advanced] Manage factories
  integrations    [integration] Manage integration providers
```

**Legacy-command rejection:**
```
npx tsx src/cli.ts setup   → ERROR Unknown command setup  (exit 1) ✓
npx tsx src/cli.ts config  → ERROR Unknown command config (exit 1) ✓
npx tsx src/cli.ts board   → ERROR Unknown command board  (exit 1) ✓
```

---

## 2. Docs Audit

### 2a. README quickstart

**Verification command:**
```
grep -n "init\|factory create\|doctor\|tick" README.md | head -20
```

**Expected:** Canonical flow is `init → factory create → doctor → tick`; no `~/.config/notionflow`, no `factory install`, no `provision-board`.

**Result (PASS):** README quickstart uses the 4-step canonical flow. Terms `notionflow.config.ts` and `--config` are present throughout.

### 2b. docs/cli-reference.md

**Verification command:**
```
grep -c "notionflow.config.ts\|--config" docs/cli-reference.md
```

**Expected:** Both terms appear; no `config set`, no `board` command group.

**Result (PASS):** `notionflow.config.ts` and `--config` appear multiple times. Legacy command groups (`config`, `board`) are absent from the command groups list.

### 2c. Forbidden-pattern scan

**Verification command:**
```
grep -rn "~/.config/notionflow\|factory install" docs/ skills/ README.md
```

**Expected:** No output.

**Result (PASS):** No matches found.

---

## 3. Skills Audit

### 3a. skills/setup/SKILL.md

**Expected:** No `~/.config/notionflow` paths, no `npx notionflow setup`, no `config set`; uses `init`, `notionflow.config.ts`, env vars for credentials.

**Result (PASS):** Skill uses `notionflow init`, `.env` file for credentials, `notionflow.config.ts` factories array.

### 3b. skills/add-factory/SKILL.md

**Expected:** No `factory install`, no `~/.config/notionflow/workflows/`; teaches local scaffold + `notionflow.config.ts` factories array update.

**Result (PASS):** Skill scaffolds `./factories/<id>.ts` locally and registers in `notionflow.config.ts`. No install steps.

---

## 4. Examples Audit

### 4a. example-factories package

**Verification command:**
```
cat example-factories/package.json
```

**Expected:** Has `doctor`, `tick`, and `tick:demo` scripts; uses local `tsx ../src/cli.ts`.

**Result (PASS):** `package.json` present with runnable scripts.

### 4b. example-factories README

**Expected:** Documents env vars, setup from clean checkout, script usage.

**Result (PASS):** README covers prerequisites, env var table, and `npm run` script table.

---

## 5. No-Global-Write Verification

**Verification command:**
```
grep -rn "~/.config/notionflow" src/ docs/ skills/ README.md
```

**Expected:** No matches — no code or docs write to or read from the global config path.

**Result (PASS):** No matches found.

---

## 6. Guardrails Test

**Verification command:**
```
npm run test
```

**Expected:** `src/guardrails.test.ts` passes (forbidden-pattern scan + required-term assertions).

**Result (PASS):**
```
Test Files  12 passed (12)
      Tests  47 passed (47)
   Duration  3.89s
```

---

## 7. Typecheck

**Verification command:**
```
npm run check
```

**Expected:** Exit 0, no type errors.

**Result (PASS):** `tsc --noEmit` exits cleanly.

---

## Sign-off

| Area              | Status |
|-------------------|--------|
| CLI help          | ✓ PASS |
| README            | ✓ PASS |
| docs/cli-reference| ✓ PASS |
| skills/setup      | ✓ PASS |
| skills/add-factory| ✓ PASS |
| example-factories | ✓ PASS |
| No global writes  | ✓ PASS |
| Guardrails tests  | ✓ PASS |
| Typecheck         | ✓ PASS |

**Ready to merge.**
