import { copyFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { defineCommand } from "citty";
import { eq } from "drizzle-orm";
import YAML from "yaml";
import { nowIso, openApp } from "../app/context";
import { notionToken, notionWorkspacePageId } from "../config/env";
import { paths } from "../config/paths";
import { workflowSchema } from "../core/workflow";
import { boards, workflows } from "../db/schema";
import { notionCreateBoardDataSource, notionFindPageByTitle, notionGetDataSource } from "../services/notion";

function prettifyBoardId(id: string): string {
  return id
    .split(/[-_]/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

async function saveWorkflow(workflowPath: string) {
  const yaml = await readFile(workflowPath, "utf8");
  const parsed = workflowSchema.parse(YAML.parse(yaml));
  const { db } = await openApp();
  const timestamp = nowIso();

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

  return parsed;
}

export async function installWorkflowFromPath(inputPath: string) {
  await openApp();
  const sourcePath = path.resolve(inputPath);
  const yaml = await readFile(sourcePath, "utf8");
  const parsed = workflowSchema.parse(YAML.parse(yaml));
  const targetPath = path.join(paths.workflowsDir, `${parsed.id}.yaml`);

  await copyFile(sourcePath, targetPath);
  await saveWorkflow(targetPath);

  console.log(`Workflow installed: ${parsed.id}`);
  console.log(`Path: ${targetPath}`);

  return parsed;
}

export async function maybeProvisionNotionBoard(boardId: string, title: string, parentPageIdArg?: string): Promise<void> {
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

  const created = await notionCreateBoardDataSource(token, parentPageId, title);
  const timestamp = nowIso();
  await db
    .insert(boards)
    .values({
      id: boardId,
      adapter: "notion",
      externalId: created.dataSourceId,
      configJson: JSON.stringify({
        name: title,
        databaseId: created.databaseId,
        parentPageId,
        url: created.url,
      }),
      createdAt: timestamp,
      updatedAt: timestamp,
    })
    .onConflictDoUpdate({
      target: boards.id,
      set: {
        externalId: created.dataSourceId,
        configJson: JSON.stringify({
          name: title,
          databaseId: created.databaseId,
          parentPageId,
          url: created.url,
        }),
        updatedAt: timestamp,
      },
    });

  console.log(`Notion board provisioned: ${boardId} -> ${created.dataSourceId}`);
  if (created.url) console.log(`Notion URL: ${created.url}`);
}

export const workflowCmd = defineCommand({
  meta: { name: "workflow", description: "Manage workflow definitions" },
  subCommands: {
    install: defineCommand({
      meta: { name: "install", description: "Install workflow YAML into ~/.config/notionflow/workflows" },
      args: {
        path: { type: "string", required: true },
        skipNotionBoard: { type: "boolean", required: false, alias: "skip-notion-board" },
        parentPage: { type: "string", required: false, alias: "parent-page" },
      },
      async run({ args }) {
        const parsed = await installWorkflowFromPath(String(args.path));
        if (!args.skipNotionBoard) {
          await maybeProvisionNotionBoard(
            parsed.id,
            prettifyBoardId(parsed.id),
            args.parentPage ? String(args.parentPage) : undefined,
          );
        }
      },
    }),
    add: defineCommand({
      meta: { name: "add", description: "Alias of workflow install" },
      args: {
        path: { type: "string", required: true },
        skipNotionBoard: { type: "boolean", required: false, alias: "skip-notion-board" },
        parentPage: { type: "string", required: false, alias: "parent-page" },
      },
      run: async ({ args }) => {
        const parsed = await installWorkflowFromPath(String(args.path));
        if (!args.skipNotionBoard) {
          await maybeProvisionNotionBoard(
            parsed.id,
            prettifyBoardId(parsed.id),
            args.parentPage ? String(args.parentPage) : undefined,
          );
        }
      },
    }),
    create: defineCommand({
      meta: { name: "create", description: "Create a new workflow scaffold" },
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
        await saveWorkflow(targetPath);
        console.log(`Workflow scaffold created: ${id}`);
        console.log(`Edit: ${targetPath}`);

        if (!args.skipNotionBoard) {
          await maybeProvisionNotionBoard(id, prettifyBoardId(id), args.parentPage ? String(args.parentPage) : undefined);
        }
      },
    }),
    list: defineCommand({
      meta: { name: "list", description: "List workflows" },
      async run() {
        const { db } = await openApp();
        const rows = await db.select().from(workflows);
        if (rows.length === 0) {
          console.log("No workflows configured");
          return;
        }
        for (const row of rows) console.log(`${row.id}  v${row.version}`);
      },
    }),
  },
});
