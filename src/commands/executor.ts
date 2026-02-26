import { access, copyFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { defineCommand } from "citty";
import { eq } from "drizzle-orm";
import { nowIso, openApp } from "../app/context";
import { paths } from "../config/paths";
import { executors } from "../db/schema";

async function saveExecutor(id: string, commandPath: string, timeout: number | null, retries: number | null) {
  const { db } = await openApp();
  const timestamp = nowIso();
  await db
    .insert(executors)
    .values({
      id,
      commandPath,
      defaultTimeoutSeconds: timeout,
      defaultRetries: retries,
      metadataJson: "{}",
      createdAt: timestamp,
      updatedAt: timestamp,
    })
    .onConflictDoUpdate({
      target: executors.id,
      set: {
        commandPath,
        defaultTimeoutSeconds: timeout,
        defaultRetries: retries,
        updatedAt: timestamp,
      },
    });
}

export async function installExecutorFromArgs(args: { path: string; id?: string; timeout?: string; retries?: string }) {
  await openApp();
  const sourcePath = path.resolve(String(args.path));
  await access(sourcePath, constants.R_OK);

  const id = String(args.id ?? path.basename(sourcePath));
  const targetPath = path.join(paths.agentsDir, id);
  await copyFile(sourcePath, targetPath);
  await Bun.$`chmod +x ${targetPath}`;

  const timeout = args.timeout ? Number(args.timeout) : null;
  const retries = args.retries ? Number(args.retries) : null;
  await saveExecutor(id, targetPath, timeout, retries);

  console.log(`Executor installed: ${id}`);
  console.log(`Path: ${targetPath}`);
}

export const executorCmd = defineCommand({
  meta: { name: "executor", description: "Manage agent executors" },
  subCommands: {
    install: defineCommand({
      meta: { name: "install", description: "Install executor into ~/.config/notionflow/agents" },
      args: {
        path: { type: "string", required: true },
        id: { type: "string", required: false },
        timeout: { type: "string", required: false },
        retries: { type: "string", required: false },
      },
      async run({ args }) {
        await installExecutorFromArgs({
          path: String(args.path),
          id: args.id ? String(args.id) : undefined,
          timeout: args.timeout ? String(args.timeout) : undefined,
          retries: args.retries ? String(args.retries) : undefined,
        });
      },
    }),
    create: defineCommand({
      meta: { name: "create", description: "Create a new executor scaffold in ~/.config/notionflow/agents" },
      args: {
        id: { type: "string", required: true },
      },
      async run({ args }) {
        await openApp();
        const id = String(args.id);
        const targetPath = path.join(paths.agentsDir, id);
        const script = `#!/usr/bin/env bash
set -euo pipefail

case "\${AGENT_ACTION:-}" in
  describe)
    echo "name: ${id}"
    echo "description: Custom executor"
    echo "timeout: 600"
    echo "retries: 0"
    ;;
  execute)
    INPUT=$(cat)
    PROMPT=$(echo "$INPUT" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{const j=JSON.parse(d);process.stdout.write(j.prompt||"")})')
    echo "STATUS: done"
    echo "SUMMARY: replace this with your ${id} logic"
    echo "PROMPT: $PROMPT"
    ;;
  *)
    echo "Unknown AGENT_ACTION: \${AGENT_ACTION:-}" >&2
    exit 1
    ;;
esac
`;

        await writeFile(targetPath, script, "utf8");
        await Bun.$`chmod +x ${targetPath}`;
        await saveExecutor(id, targetPath, null, null);

        console.log(`Executor scaffold created: ${id}`);
        console.log(`Edit: ${targetPath}`);
      },
    }),
    add: defineCommand({
      meta: { name: "add", description: "Alias of executor install" },
      args: {
        path: { type: "string", required: true },
        id: { type: "string", required: false },
        timeout: { type: "string", required: false },
        retries: { type: "string", required: false },
      },
      run: async ({ args }) => {
        await installExecutorFromArgs({
          path: String(args.path),
          id: args.id ? String(args.id) : undefined,
          timeout: args.timeout ? String(args.timeout) : undefined,
          retries: args.retries ? String(args.retries) : undefined,
        });
      },
    }),
    list: defineCommand({
      meta: { name: "list", description: "List executors" },
      async run() {
        const { db } = await openApp();
        const rows = await db.select().from(executors);
        if (rows.length === 0) {
          console.log("No executors configured");
          return;
        }
        for (const row of rows) {
          console.log(`${row.id}  ${row.commandPath}  timeout=${row.defaultTimeoutSeconds ?? "-"} retries=${row.defaultRetries ?? "-"}`);
        }
      },
    }),
    describe: defineCommand({
      meta: { name: "describe", description: "Invoke AGENT_ACTION=describe" },
      args: {
        id: { type: "string", required: true },
      },
      async run({ args }) {
        const { db } = await openApp();
        const [executor] = await db.select().from(executors).where(eq(executors.id, String(args.id)));
        if (!executor) throw new Error(`Executor not found: ${args.id}`);

        const proc = Bun.spawn([executor.commandPath], {
          env: { ...process.env, AGENT_ACTION: "describe" },
          stdout: "pipe",
          stderr: "pipe",
        });

        const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
        const exitCode = await proc.exited;
        if (exitCode !== 0) throw new Error(`describe failed (${exitCode}): ${stderr.trim()}`);
        console.log(stdout.trim());
      },
    }),
  },
});
