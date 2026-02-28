import { copyFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { defineCommand } from "citty";
import { eq } from "drizzle-orm";
import { nowIso, openApp } from "../app/context";
import { notionToken, notionWorkspacePageId } from "../config/env";
import { paths } from "../config/paths";
import { loadFactoryFromPath, serializeFactoryDefinition } from "../core/factory";
import { boards, workflows } from "../db/schema";
import { ProjectConfigResolutionError, resolveProjectConfig } from "../project/discoverConfig";
import { notionCreateBoardDataSource, notionFindPageByTitle, notionGetDataSource } from "../services/notion";

function prettifyBoardId(id: string): string {
  return id
    .split(/[-_]/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

async function maybeProvisionNotionBoard(boardId: string, title: string, parentPageIdArg?: string): Promise<void> {
  const token = notionToken();
  if (!token) {
    console.log("[warn] skipping Notion board provisioning (NOTION_API_TOKEN missing)");
    return;
  }

  const { db } = await openApp();
  const [existingBoard] = await db.select().from(boards).where(eq(boards.id, boardId));
  if (existingBoard?.adapter === "notion") {
    try {
      await notionGetDataSource(token, existingBoard.externalId);
      console.log(`Notion board already linked: ${boardId} -> ${existingBoard.externalId}`);
      return;
    } catch {
      console.log(`[warn] existing board link is invalid; reprovisioning ${boardId}`);
    }
  }

  const parentPageId =
    parentPageIdArg ?? notionWorkspacePageId() ?? (await notionFindPageByTitle(token, "NotionFlow"));
  if (!parentPageId) {
    console.log("[warn] skipping Notion board provisioning (set NOTION_WORKSPACE_PAGE_ID or pass --parent-page)");
    return;
  }

  const created = await notionCreateBoardDataSource(token, parentPageId, title, []);
  const timestamp = nowIso();
  await db
    .insert(boards)
    .values({
      id: boardId,
      adapter: "notion",
      externalId: created.dataSourceId,
      configJson: JSON.stringify({ name: title, databaseId: created.databaseId, parentPageId, url: created.url }),
      createdAt: timestamp,
      updatedAt: timestamp,
    })
    .onConflictDoUpdate({
      target: boards.id,
      set: { externalId: created.dataSourceId, updatedAt: timestamp },
    });
  console.log(`Notion board provisioned: ${boardId} -> ${created.url}`);
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
        config: { type: "string", required: false },
        skipNotionBoard: { type: "boolean", required: false, alias: "skip-notion-board" },
        parentPage: { type: "string", required: false, alias: "parent-page" },
      },
      async run({ args }) {
        let resolvedProject;
        try {
          resolvedProject = await resolveProjectConfig({
            startDir: process.cwd(),
            configPath: args.config ? String(args.config) : undefined,
          });
        } catch (error) {
          if (!(error instanceof ProjectConfigResolutionError)) {
            throw error;
          }

          console.error(`[error] ${error.message}`);
          console.error(`Start directory: ${error.startDir}`);
          if (error.attemptedPath) {
            console.error(`Attempted config path: ${error.attemptedPath}`);
          }
          console.error("Run `notionflow init` in your project root first, or pass --config <path>.");
          process.exitCode = 1;
          return;
        }

        const id = String(args.id);
        const targetDir = path.join(resolvedProject.projectRoot, "factories");
        const targetPath = path.join(targetDir, `${id}.ts`);
        const template = `const doWork = async ({ ctx }) => ({\n  status: \"done\",\n  data: { ...ctx, result: \"ok\" },\n});\n\nexport default {\n  id: \"${id}\",\n  start: \"start\",\n  context: {},\n  states: {\n    start: {\n      type: \"action\",\n      agent: doWork,\n      on: { done: \"done\", failed: \"failed\" },\n    },\n    done: { type: \"done\" },\n    failed: { type: \"failed\" },\n  },\n};\n`;
        await mkdir(targetDir, { recursive: true });
        await writeFile(targetPath, template, "utf8");

        console.log(`Factory scaffold created: ${id}`);
        console.log(`Path: ${targetPath}`);

        if (!args.skipNotionBoard) {
          console.log("[warn] Notion board provisioning is not yet supported for local-only factory scaffolds.");
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
