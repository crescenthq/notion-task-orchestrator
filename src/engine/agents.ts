import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { parseKeyValueOutput } from "./output-parser.js";
import { paths } from "../config/paths.js";

export type AgentMetadata = {
  name: string;
  description: string;
  timeout: number;
  retries: number;
};

export type ExecuteOptions = {
  prompt: string;
  session_id: string;
  timeout?: number;
  workdir?: string;
};

function safeInt(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

export function agentsDir(): string {
  return process.env.AGENTS_DIR ?? paths.agents;
}

export async function listAgents(): Promise<string[]> {
  try {
    const entries = await readdir(agentsDir(), { withFileTypes: true });
    return entries
      .filter((e) => e.isFile())
      .map((e) => e.name)
      .sort();
  } catch (err: any) {
    if (err?.code === "ENOENT") return [];
    throw err;
  }
}

export async function describeAgent(name: string): Promise<AgentMetadata> {
  const agentPath = path.join(agentsDir(), name);
  const stdout = await spawnAgent(agentPath, "describe");
  const kv = parseKeyValueOutput(stdout);

  return {
    name: kv.name ?? name,
    description: kv.description ?? "",
    timeout: safeInt(kv.timeout, 600),
    retries: safeInt(kv.retries, 1),
  };
}

export async function executeAgent(name: string, opts: ExecuteOptions): Promise<string> {
  const agentPath = path.join(agentsDir(), name);
  const payload = JSON.stringify({
    prompt: opts.prompt,
    session_id: opts.session_id,
    timeout: opts.timeout ?? 600,
    workdir: opts.workdir ?? ".",
  });

  const timeoutMs = (opts.timeout ?? 600) * 1000;
  return spawnAgent(agentPath, "execute", payload, timeoutMs);
}

function spawnAgent(
  agentPath: string,
  action: string,
  stdin?: string,
  timeoutMs = 30_000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(agentPath, [], {
      env: { ...process.env, AGENT_ACTION: action },
      stdio: ["pipe", "pipe", "pipe"],
      timeout: timeoutMs,
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    proc.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

    if (stdin) {
      proc.stdin.write(stdin);
      proc.stdin.end();
    } else {
      proc.stdin.end();
    }

    proc.on("error", (err) => reject(err));
    proc.on("close", (code) => {
      if (code === 0) {
        resolve(stdout.trim());
        return;
      }
      reject(
        new Error(
          `Agent ${path.basename(agentPath)} ${action} failed (exit=${code}): ${stderr.trim() || stdout.trim()}`,
        ),
      );
    });
  });
}
