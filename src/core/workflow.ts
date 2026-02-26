import { z } from "zod";

export const workflowSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  steps: z
    .array(
      z.object({
        id: z.string().min(1),
        agent: z.string().min(1),
        prompt: z.string().min(1),
        timeout: z.number().int().positive().optional(),
        retries: z.number().int().min(0).optional(),
        on_success: z.enum(["next", "done", "blocked", "failed"]).optional(),
        on_fail: z.enum(["next", "done", "blocked", "failed"]).optional(),
      }),
    )
    .min(1),
});

export type WorkflowDefinition = z.infer<typeof workflowSchema>;

export function parseStatusDirective(output: string): "done" | "retry" | "blocked" | "failed" | null {
  const match = output.match(/^STATUS:\s*(done|retry|blocked|failed)\s*$/im);
  return (match?.[1] as "done" | "retry" | "blocked" | "failed" | undefined) ?? null;
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
  return template.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => vars[name] ?? `{{${name}}}`);
}
