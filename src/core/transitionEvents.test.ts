import { describe, expect, it } from "vitest";
import { parseTransitionEvent, replayTransitionEvents } from "./transitionEvents";

function baseEvent() {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    runId: "run-1",
    tickId: "tick-1",
    taskId: "task-1",
    fromStateId: "work",
    toStateId: "done",
    event: "done",
    reason: "action.done" as const,
    attempt: 1,
    loopIteration: 0,
    timestamp: now,
  };
}

describe("transitionEvents", () => {
  it("rejects unknown reason codes", () => {
    const candidate = {
      ...baseEvent(),
      reason: "action.custom",
    };
    expect(() => parseTransitionEvent(candidate)).toThrow();
  });

  it("rejects invalid reason/event pairings", () => {
    const candidate = {
      ...baseEvent(),
      event: "feedback",
      reason: "action.done" as const,
    };
    expect(() => parseTransitionEvent(candidate)).toThrow("requires event `done`");
  });

  it("replays with feedback resume discontinuity", () => {
    const now = new Date().toISOString();
    const replayed = replayTransitionEvents([
      {
        id: "evt-1",
        runId: "run-1",
        tickId: "tick-1",
        taskId: "task-1",
        fromStateId: "work",
        toStateId: "await_human",
        event: "feedback",
        reason: "action.feedback",
        attempt: 1,
        loopIteration: 0,
        timestamp: now,
      },
      {
        id: "evt-2",
        runId: "run-1",
        tickId: "tick-2",
        taskId: "task-1",
        fromStateId: "work",
        toStateId: "done",
        event: "done",
        reason: "action.done",
        attempt: 2,
        loopIteration: 0,
        timestamp: now,
      },
    ]);
    expect(replayed).toBe("done");
  });

  it("fails replay when from-state continuity breaks without feedback resume", () => {
    const now = new Date().toISOString();
    expect(() =>
      replayTransitionEvents([
        {
          id: "evt-1",
          runId: "run-1",
          tickId: "tick-1",
          taskId: "task-1",
          fromStateId: "work",
          toStateId: "route",
          event: "done",
          reason: "action.done",
          attempt: 1,
          loopIteration: 0,
          timestamp: now,
        },
        {
          id: "evt-2",
          runId: "run-1",
          tickId: "tick-1",
          taskId: "task-1",
          fromStateId: "other",
          toStateId: "done",
          event: "matched",
          reason: "orchestrate.select",
          attempt: 1,
          loopIteration: 0,
          timestamp: now,
        },
      ]),
    ).toThrow("Replay mismatch");
  });
});
