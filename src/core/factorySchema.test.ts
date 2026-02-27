import { describe, expect, it } from "vitest";
import { factorySchema } from "./factorySchema";

describe("factorySchema", () => {
  it("parses a minimal valid factory", () => {
    const parsed = factorySchema.parse({
      id: "sample-factory",
      start: "start",
      states: {
        start: {
          type: "action",
          agent: async () => ({ status: "done" }),
          on: { done: "done", failed: "failed" },
        },
        done: { type: "done" },
        failed: { type: "failed" },
      },
    });

    expect(parsed.id).toBe("sample-factory");
    expect(parsed.start).toBe("start");
  });

  it("rejects missing transition targets", () => {
    expect(() =>
      factorySchema.parse({
        id: "bad-factory",
        start: "start",
        states: {
          start: {
            type: "action",
            agent: async () => ({ status: "done" }),
            on: { done: "missing", failed: "failed" },
          },
          done: { type: "done" },
          failed: { type: "failed" },
        },
      }),
    ).toThrow(/missing target/);
  });

  it("requires action done/failed transition routes", () => {
    expect(() =>
      factorySchema.parse({
        id: "action-events-factory",
        start: "start",
        states: {
          start: {
            type: "action",
            agent: async () => ({ status: "done" }),
            on: { done: "done" },
          },
          done: { type: "done" },
          failed: { type: "failed" },
        },
      }),
    ).toThrow(/on\.failed/);
  });

  it("rejects loop until guards that do not exist", () => {
    expect(() =>
      factorySchema.parse({
        id: "loop-factory",
        start: "loop",
        states: {
          loop: {
            type: "loop",
            body: "work",
            maxIterations: 3,
            until: "qualityReached",
            on: { continue: "work", exhausted: "failed", done: "done" },
          },
          work: {
            type: "action",
            agent: async () => ({ status: "done" }),
            on: { done: "done", failed: "failed" },
          },
          done: { type: "done" },
          failed: { type: "failed" },
        },
      }),
    ).toThrow(/missing guard/);
  });

  it("requires loop continue/done/exhausted transition routes", () => {
    expect(() =>
      factorySchema.parse({
        id: "loop-events-factory",
        start: "loop",
        guards: {
          qualityReached: () => false,
        },
        states: {
          loop: {
            type: "loop",
            body: "work",
            maxIterations: 2,
            until: "qualityReached",
            on: { continue: "work", done: "done" },
          },
          work: {
            type: "action",
            agent: async () => ({ status: "done" }),
            on: { done: "loop", failed: "failed" },
          },
          done: { type: "done" },
          failed: { type: "failed" },
        },
      }),
    ).toThrow(/on\.exhausted/);
  });

  it("accepts action retries using retries.max with optional backoff", () => {
    const parsed = factorySchema.parse({
      id: "retry-factory",
      start: "start",
      states: {
        start: {
          type: "action",
          agent: async () => ({ status: "done" }),
          retries: {
            max: 2,
            backoff: { strategy: "exponential", ms: 10, maxMs: 100 },
          },
          on: { done: "done", failed: "failed" },
        },
        done: { type: "done" },
        failed: { type: "failed" },
      },
    });

    const retries = parsed.states.start.type === "action" ? parsed.states.start.retries : undefined;
    expect(retries?.max).toBe(2);
    expect(retries?.backoff?.strategy).toBe("exponential");
  });

  it("rejects retries configs that omit max/maxRetries", () => {
    expect(() =>
      factorySchema.parse({
        id: "bad-retry-factory",
        start: "start",
        states: {
          start: {
            type: "action",
            agent: async () => ({ status: "done" }),
            retries: { backoff: { ms: 10 } },
            on: { done: "done", failed: "failed" },
          },
          done: { type: "done" },
          failed: { type: "failed" },
        },
      }),
    ).toThrow(/exactly one of `max` or `maxRetries`/);
  });
});
