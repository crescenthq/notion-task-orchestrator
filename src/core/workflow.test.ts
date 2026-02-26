import { describe, expect, it } from "vitest";
import { workflowSchema, workflowStepById, workflowStepIcon } from "./workflow";

describe("workflow schema step icon metadata", () => {
  const baseWorkflow = {
    id: "wf-1",
    name: "Workflow",
    steps: [
      {
        id: "s1",
        agent: "shell",
        prompt: "echo ok",
      },
    ],
  };

  it("parses workflows with and without optional icon fields", () => {
    const withoutIcon = workflowSchema.parse(baseWorkflow);
    expect(workflowStepIcon(withoutIcon.steps[0]!)).toBeNull();

    const withStatusIcon = workflowSchema.parse({
      ...baseWorkflow,
      steps: [{ ...baseWorkflow.steps[0], status_icon: "🧠" }],
    });
    expect(workflowStepIcon(withStatusIcon.steps[0]!)).toBe("🧠");

    const withIconAlias = workflowSchema.parse({
      ...baseWorkflow,
      steps: [{ ...baseWorkflow.steps[0], icon: "⚙️" }],
    });
    expect(workflowStepIcon(withIconAlias.steps[0]!)).toBe("⚙️");
  });

  it("fails validation for empty or non-string icon values", () => {
    expect(() =>
      workflowSchema.parse({
        ...baseWorkflow,
        steps: [{ ...baseWorkflow.steps[0], status_icon: "" }],
      }),
    ).toThrow();

    expect(() =>
      workflowSchema.parse({
        ...baseWorkflow,
        steps: [{ ...baseWorkflow.steps[0], icon: 123 }],
      }),
    ).toThrow();
  });

  it("provides typed accessors for workflow steps", () => {
    const parsed = workflowSchema.parse({
      ...baseWorkflow,
      steps: [
        { ...baseWorkflow.steps[0], status_icon: "🧭" },
        { id: "s2", agent: "shell", prompt: "echo done" },
      ],
    });

    const step = workflowStepById(parsed, "s1");
    expect(step?.id).toBe("s1");
    expect(step ? workflowStepIcon(step) : null).toBe("🧭");
    expect(workflowStepById(parsed, "missing")).toBeNull();
  });
});

describe("workflow schema step approval metadata", () => {
  const baseWorkflow = {
    id: "wf-approval-1",
    name: "Workflow Approval",
    steps: [
      {
        id: "s1",
        agent: "shell",
        prompt: "echo ok",
      },
    ],
  };

  it("parses workflows with and without optional approval fields", () => {
    const withoutApproval = workflowSchema.parse(baseWorkflow);
    expect(withoutApproval.steps[0]?.requires_human_approval).toBeUndefined();
    expect(withoutApproval.steps[0]?.approval_instructions).toBeUndefined();

    const withApprovalGate = workflowSchema.parse({
      ...baseWorkflow,
      steps: [
        {
          ...baseWorkflow.steps[0],
          requires_human_approval: true,
          approval_instructions: "Review the generated plan before continuing.",
        },
      ],
    });

    expect(withApprovalGate.steps[0]?.requires_human_approval).toBe(true);
    expect(withApprovalGate.steps[0]?.approval_instructions).toBe("Review the generated plan before continuing.");
  });

  it("fails validation for invalid approval metadata values", () => {
    expect(() =>
      workflowSchema.parse({
        ...baseWorkflow,
        steps: [{ ...baseWorkflow.steps[0], requires_human_approval: "yes" }],
      }),
    ).toThrow();

    expect(() =>
      workflowSchema.parse({
        ...baseWorkflow,
        steps: [{ ...baseWorkflow.steps[0], approval_instructions: "" }],
      }),
    ).toThrow();
  });
});
