#!/usr/bin/env node
import { defineCommand, runMain } from "citty";
import { boardCmd } from "./commands/board";
import { configCmd } from "./commands/config";
import { doctorCmd } from "./commands/doctor";
import { executorCmd } from "./commands/executor";
import { initCmd } from "./commands/init";
import { notionCmd } from "./commands/notion";
import { runCmd } from "./commands/run";
import { setupCmd } from "./commands/setup";
import { statusCmd } from "./commands/status";
import { tickCmd } from "./commands/tick";
import { workflowCmd } from "./commands/workflow";

const main = defineCommand({
  meta: {
    name: "notionflow",
    description: "Minimal agent-agnostic orchestrator",
    version: "0.1.0",
  },
  subCommands: {
    init: initCmd,
    setup: setupCmd,
    config: configCmd,
    doctor: doctorCmd,
    board: boardCmd,
    executor: executorCmd,
    workflow: workflowCmd,
    notion: notionCmd,
    tick: tickCmd,
    run: runCmd,
    status: statusCmd,
  },
});

runMain(main);
