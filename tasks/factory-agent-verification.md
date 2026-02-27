# Verification Log: Factories (Live Notion, Ralph Loop)

Use this document to run and record live verification outcomes for the code-first factory runtime.

## Fixture Factories

- `tasks/factories/verify-happy.ts`
- `tasks/factories/verify-feedback.ts`
- `tasks/factories/verify-retry-failure.ts`
- `tasks/factories/verify-loop.ts`
- `tasks/factories/verify-resume-budget.ts`

## Automated Runner

Run all live scenarios and produce an artifact JSON:

```bash
NOTION_API_TOKEN=... npx tsx tasks/scripts/run-factory-verification.ts
```

Optional environment variables:

- `NOTION_WORKSPACE_PAGE_ID` (preferred parent page for board provisioning)
- `NOTIONFLOW_VERIFY_PARENT_PAGE_ID` (fallback parent page used by the script)
- `NOTIONFLOW_VERIFY_FEEDBACK_MODE` (`manual`, `notion-comment`, or `local`; default: `local`)

Output artifact:

- `tasks/artifacts/factory-live-verification-<UTCSTAMP>.json`

## Manual Commands (Equivalent)

```bash
npx notionflow factory install --path tasks/factories/verify-happy.ts
npx notionflow factory install --path tasks/factories/verify-feedback.ts
npx notionflow factory install --path tasks/factories/verify-retry-failure.ts
npx notionflow factory install --path tasks/factories/verify-loop.ts
npx notionflow factory install --path tasks/factories/verify-resume-budget.ts
```

## Environment

- Date:
- Operator:
- Branch:
- Commit SHA:
- Node version:
- Command runner (`npx`/local):
- `NOTION_API_TOKEN` configured: yes/no
- Parent page ID used:
- Worker lease mode (strict/best-effort):

## Scenario A: Happy Path (`done`)

### Expected

- Task transitions `queued -> running -> done`
- Notion status/log entries follow transitions
- Transition events include required fields (`runId`, `tickId`, `from`, `to`, `event`, `reason`)

### Observed

- Factory ID:
- Task ID:
- Run ID:
- Event count:
- Tick timeline:
- Final state:

## Scenario B: Feedback Pause/Resume

### Expected

- Task transitions `queued -> running -> feedback -> queued/running -> done`
- Feedback question posted to Notion comments
- Human response consumed and injected into resumed run
- Resume returns to previously paused state by default
- Reprocessing the same feedback payload does not duplicate side effects

### Observed

- Factory ID:
- Task ID:
- Run ID:
- Question posted:
- Resume marker found in logs:
- Final state:

## Scenario C: Retry then Failure

### Expected

- Runtime attempts state `maxRetries + 1` times
- Task transitions to configured failure state on exhaustion
- Attempt metadata appears in transition events

### Observed

- Factory ID:
- Task ID:
- Run ID:
- Exhausted attempt metadata:
- Final terminal state:
- Error/log excerpt:

## Scenario D: Bounded Loop

### Expected

- Loop exits by `done` guard or by `exhausted` cap
- Loop counters persist in context/logs
- Loop iteration index appears in transition events

### Observed

- Factory ID:
- Task ID:
- Run ID:
- Iteration count:
- Exit reason:
- Final state:

## Scenario E: Crash/Resume + Deterministic Replay

### Expected

- With `maxTransitionsPerTick=1`, run resumes from persisted state/context across ticks
- Completed transitions are not duplicated on subsequent ticks
- Replay of `transition_events` reproduces final terminal state

### Observed

- Factory ID:
- Task ID:
- Run ID:
- Tick count:
- Replay terminal state:
- Duplicate side effects found (yes/no):
- Final state:

## Summary

- Scenario A: pass/fail
- Scenario B: pass/fail
- Scenario C: pass/fail
- Scenario D: pass/fail
- Scenario E: pass/fail

## Required Artifacts

- Board/factory IDs and task IDs for all scenarios
- Tick timeline (`tickId`, transition count per tick)
- Transition event export or artifact JSON for each scenario
- Timestamped Notion status/comment evidence

## Follow-up Fixes

1.
2.
3.
