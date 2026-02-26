import { z } from "zod";

const stepSchema = z.object({
  id: z.string().min(1),
  agent: z.string().min(1),
  prompt: z.string().min(1),
  timeout: z.number().int().positive().optional(),
  retries: z.number().int().min(0).optional(),
  on_success: z.enum(["next", "done", "blocked", "failed"]).optional(),
  on_fail: z.enum(["next", "done", "blocked", "failed"]).optional(),
  requires_human_approval: z.boolean().optional(),
  approval_instructions: z.string().min(1).optional(),
  status_icon: z.string().min(1).optional(),
  icon: z.string().min(1).optional(),
});

export const workflowSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  steps: z.array(stepSchema).min(1),
});

export type WorkflowDefinition = z.infer<typeof workflowSchema>;
export type WorkflowStepDefinition = z.infer<typeof stepSchema>;

export function workflowStepIcon(step: WorkflowStepDefinition): string | null {
  return step.status_icon ?? step.icon ?? null;
}

export function workflowStepById(workflow: WorkflowDefinition, stepId: string): WorkflowStepDefinition | null {
  return workflow.steps.find((step) => step.id === stepId) ?? null;
}

export function parseStatusDirective(output: string): "done" | "retry" | "blocked" | "failed" | "waiting" | null {
  const match = output.match(/^STATUS:\s*(done|retry|blocked|failed|waiting)\s*$/im);
  return (match?.[1] as "done" | "retry" | "blocked" | "failed" | "waiting" | undefined) ?? null;
}

export function parseKeyValues(output: string): Record<string, string> {
  const kv: Record<string, string> = {};
  for (const line of output.split("\n")) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*):\s+(.+)$/);
    if (!m) continue;
    kv[m[1].toLowerCase()] = m[2];
  }
  return kv;
}

export function renderTemplate(template: string, vars: Record<string, string>): string {
  // Handle {{#if var}}content{{/if}} blocks: include content only when var is non-empty
  const withConditionals = template.replace(
    /\{\{#if\s+(\w+)\}\}([\s\S]*?)\{\{\/if\}\}/g,
    (_match, name: string, content: string) => (vars[name] ? content : ""),
  );
  // Replace remaining {{var}} placeholders
  return withConditionals.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => vars[name] ?? "");
}
