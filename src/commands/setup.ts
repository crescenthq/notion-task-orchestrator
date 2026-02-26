import { access, constants } from "node:fs";
import path from "node:path";
import { defineCommand } from "citty";
import { openApp } from "../app/context";
import { installExecutorFromArgs } from "./executor";
import { maybeProvisionNotionBoard, installWorkflowFromPath } from "./workflow";

type BundledExecutor = {
  id: string;
  sourcePath: string;
};

const bundledExecutors: BundledExecutor[] = [
  { id: "claude", sourcePath: path.resolve(import.meta.dir, "../../agents/claude") },
  { id: "codex", sourcePath: path.resolve(import.meta.dir, "../../agents/codex") },
  { id: "shell", sourcePath: path.resolve(import.meta.dir, "../../agents/shell") },
];

const defaultWorkflowPath = path.resolve(import.meta.dir, "../../workflows/mixed-default.yaml");

async function pathExists(filePath: string): Promise<boolean> {
  return new Promise((resolve) => {
    access(filePath, constants.R_OK, (error) => resolve(!error));
  });
}

export const setupCmd = defineCommand({
  meta: { name: "setup", description: "Bootstrap local workspace with bundled executors and workflow" },
  args: {
    workflowPath: { type: "string", required: false, alias: "workflow-path" },
    noNotionBoard: { type: "boolean", required: false, alias: "no-notion-board" },
    parentPage: { type: "string", required: false, alias: "parent-page" },
    skipExecutors: { type: "boolean", required: false, alias: "skip-executors" },
    skipWorkflow: { type: "boolean", required: false, alias: "skip-workflow" },
  },
  async run({ args }) {
    await openApp();
    console.log("Local workspace ready");

    if (!args.skipExecutors) {
      for (const executor of bundledExecutors) {
        if (!(await pathExists(executor.sourcePath))) {
          console.log(`[warn] skipping bundled executor ${executor.id}; missing ${executor.sourcePath}`);
          continue;
        }

        await installExecutorFromArgs({ path: executor.sourcePath, id: executor.id });
      }
    }

    if (args.skipWorkflow) {
      console.log("Setup complete");
      return;
    }

    const workflowPath = args.workflowPath ? path.resolve(String(args.workflowPath)) : defaultWorkflowPath;
    if (!(await pathExists(workflowPath))) {
      throw new Error(`Workflow file not found: ${workflowPath}`);
    }

    const workflow = await installWorkflowFromPath(workflowPath);
    if (!args.noNotionBoard) {
      await maybeProvisionNotionBoard(
        workflow.id,
        `NotionFlow • ${workflow.id}`,
        args.parentPage ? String(args.parentPage) : undefined,
      );
    }

    console.log(`Setup complete: workflow=${workflow.id}`);
    console.log("Next: run `notionflow tick` to sync + execute queued tasks");
  },
});
