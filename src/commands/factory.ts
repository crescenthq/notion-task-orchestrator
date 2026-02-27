import { copyFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { defineCommand } from "citty";
import { nowIso, openApp } from "../app/context";
import { paths } from "../config/paths";
import { loadFactoryFromPath, serializeFactoryDefinition } from "../core/factory";
import { workflows } from "../db/schema";
import { maybeProvisionNotionBoard } from "./workflow";

function prettifyBoardId(id: string): string {
  return id
    .split(/[-_]/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

async function saveFactoryDefinition(inputPath: string): Promise<{ id: string; sourcePath: string }> {
  const loaded = await loadFactoryFromPath(inputPath);
  const { db } = await openApp();
  const timestamp = nowIso();

  await db
    .insert(workflows)
    .values({
      id: loaded.definition.id,
      version: 1,
      definitionYaml: serializeFactoryDefinition(loaded.definition),
      createdAt: timestamp,
      updatedAt: timestamp,
    })
    .onConflictDoUpdate({
      target: workflows.id,
      set: {
        definitionYaml: serializeFactoryDefinition(loaded.definition),
        updatedAt: timestamp,
      },
    });

  return { id: loaded.definition.id, sourcePath: loaded.sourcePath };
}

async function installFactoryFromPath(inputPath: string): Promise<{ id: string; targetPath: string }> {
  await openApp();
  const loaded = await loadFactoryFromPath(inputPath);
  const sourcePath = loaded.sourcePath;
  const extension = path.extname(sourcePath) || ".ts";
  const targetPath = path.join(paths.workflowsDir, `${loaded.definition.id}${extension}`);

  await copyFile(sourcePath, targetPath);
  await saveFactoryDefinition(targetPath);

  return { id: loaded.definition.id, targetPath };
}

export const factoryCmd = defineCommand({
  meta: { name: "factory", description: "[advanced] Manage factories" },
  subCommands: {
    install: defineCommand({
      meta: { name: "install", description: "Install a TypeScript factory module from a local file" },
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
      meta: { name: "create", description: "Create a new TypeScript factory scaffold" },
      args: {
        id: { type: "string", required: true },
        skipNotionBoard: { type: "boolean", required: false, alias: "skip-notion-board" },
        parentPage: { type: "string", required: false, alias: "parent-page" },
      },
      async run({ args }) {
        await openApp();
        const id = String(args.id);
        const targetPath = path.join(paths.workflowsDir, `${id}.ts`);
        const template = `const doWork = async ({ ctx }) => ({\n  status: \"done\",\n  data: { ...ctx, result: \"ok\" },\n});\n\nexport default {\n  id: \"${id}\",\n  start: \"start\",\n  context: {},\n  states: {\n    start: {\n      type: \"action\",\n      agent: doWork,\n      on: { done: \"done\", failed: \"failed\" },\n    },\n    done: { type: \"done\" },\n    failed: { type: \"failed\" },\n  },\n};\n`;
        await writeFile(targetPath, template, "utf8");
        await saveFactoryDefinition(targetPath);

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
