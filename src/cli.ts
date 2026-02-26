#!/usr/bin/env node
import { defineCommand, runMain } from "citty";
import { boardCmd } from "./commands/board";
import { configCmd } from "./commands/config";
import { doctorCmd } from "./commands/doctor";
import { executorCmd } from "./commands/executor";
import { integrationsCmd } from "./commands/integrations";
import { runCmd } from "./commands/run";
import { setupCmd } from "./commands/setup";
import { statusCmd } from "./commands/status";
import { tickCmd } from "./commands/tick";
import { workflowCmd } from "./commands/workflow";

const main = defineCommand({
  meta: {
    name: "notionflow",
    description: "Orchestration-first CLI (common + advanced + integration commands)",
    version: "0.1.0",
  },
  subCommands: {
    setup: setupCmd,
    doctor: doctorCmd,
    tick: tickCmd,
    run: runCmd,
    status: statusCmd,
    config: configCmd,
    board: boardCmd,
    executor: executorCmd,
    workflow: workflowCmd,
    integrations: integrationsCmd,
  },
});

runMain(main);
