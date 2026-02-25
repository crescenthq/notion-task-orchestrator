const KV_LINE_RE = /^([A-Za-z_][A-Za-z0-9_]*):\s+(.+)$/;
const STATUS_DIRECTIVE_RE = /^STATUS:\s*(done|retry|blocked|failed)\s*$/im;

export function parseKeyValueOutput(output: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of output.split("\n")) {
    const match = line.trim().match(KV_LINE_RE);
    if (match) {
      result[match[1].toLowerCase()] = match[2].trim();
    }
  }
  return result;
}

export type StatusDirective = "done" | "retry" | "blocked" | "failed";

export function parseStatusDirective(output: string): StatusDirective | null {
  const match = output.match(STATUS_DIRECTIVE_RE);
  if (!match) return null;
  return match[1] as StatusDirective;
}
