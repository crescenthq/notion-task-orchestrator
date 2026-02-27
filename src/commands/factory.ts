import { copyFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { defineCommand } from "citty";
import YAML from "yaml";
import { openApp } from "../app/context";
import { paths } from "../config/paths";
import { workflowSchema } from "../core/workflow";
import { workflows } from "../db/schema";
import { maybeProvisionNotionBoard } from "./workflow";

function prettifyBoardId(id: string): string {
  return id
    .split(/[-_]/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

async function saveFactoryFile(factoryPath: string): Promise<{ id: string }> {
  const yaml = await readFile(factoryPath, "utf8");
  const parsed = workflowSchema.parse(YAML.parse(yaml));
  const { db } = await openApp();
  const timestamp = new Date().toISOString();

  await db
    .insert(workflows)
    .values({
      id: parsed.id,
      version: 1,
      definitionYaml: yaml,
      createdAt: timestamp,
      updatedAt: timestamp,
    })
    .onConflictDoUpdate({
      target: workflows.id,
      set: {
        definitionYaml: yaml,
        updatedAt: timestamp,
      },
    });

  return { id: parsed.id };
}

async function installFactoryFromPath(inputPath: string): Promise<{ id: string; targetPath: string }> {
  await openApp();
  const sourcePath = path.resolve(inputPath);
  const yaml = await readFile(sourcePath, "utf8");
  const parsed = workflowSchema.parse(YAML.parse(yaml));
  const targetPath = path.join(paths.workflowsDir, `${parsed.id}.yaml`);

  await copyFile(sourcePath, targetPath);
  await saveFactoryFile(targetPath);

  return { id: parsed.id, targetPath };
}

export const factoryCmd = defineCommand({
  meta: { name: "factory", description: "[advanced] Manage factories" },
  subCommands: {
    install: defineCommand({
      meta: { name: "install", description: "Install a factory definition from a local file" },
      args: {
        path: { type: "string", required: true },
        skipNotionBoard: { type: "boolean", required: false, alias: "skip-notion-board" },
        parentPage: { type: "string", required: false, alias: "parent-page" },
      },
      async run({ args }) {
        const installed = await installFactoryFromPath(String(args.path));
        console.log(`Factory installed: ${installed.id}`);
        console.log(`Path: ${installed.targetPath}`);
        if (!args.skipNotionBoard) {
          await maybeProvisionNotionBoard(
            installed.id,
            prettifyBoardId(installed.id),
            args.parentPage ? String(args.parentPage) : undefined,
          );
        }
      },
    }),
    create: defineCommand({
      meta: { name: "create", description: "Create a new factory scaffold" },
      args: {
        id: { type: "string", required: true },
        skipNotionBoard: { type: "boolean", required: false, alias: "skip-notion-board" },
        parentPage: { type: "string", required: false, alias: "parent-page" },
      },
      async run({ args }) {
        await openApp();
        const id = String(args.id);
        const targetPath = path.join(paths.workflowsDir, `${id}.yaml`);
        const template = `id: ${id}
name: ${id}
steps:
  - id: step1
    agent: shell
    prompt: |
      echo "STATUS: done"
      echo "RESULT: Replace with your real step"
    timeout: 120
    retries: 0
    on_success: done
    on_fail: blocked
`;
        await writeFile(targetPath, template, "utf8");
        await saveFactoryFile(targetPath);

        console.log(`Factory scaffold created: ${id}`);
        console.log(`Edit: ${targetPath}`);

        if (!args.skipNotionBoard) {
          await maybeProvisionNotionBoard(id, prettifyBoardId(id), args.parentPage ? String(args.parentPage) : undefined);
        }
      },
    }),
    list: defineCommand({
      meta: { name: "list", description: "List installed factories" },
      async run() {
        const { db } = await openApp();
        const rows = await db.select().from(workflows);
        if (rows.length === 0) {
          console.log("No factories configured");
          return;
        }
        for (const row of rows) console.log(`${row.id}  v${row.version}`);
      },
    }),
  },
});
