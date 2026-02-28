import { describe, expect, it } from "vitest";
import { boardCmd } from "./commands/board";
import { configCmd } from "./commands/config";
import { doctorCmd } from "./commands/doctor";
import { factoryCmd } from "./commands/factory";
import { integrationsCmd } from "./commands/integrations";
import { runCmd } from "./commands/run";
import { setupCmd } from "./commands/setup";
import { statusCmd } from "./commands/status";
import { tickCmd } from "./commands/tick";

function descriptionOf(command: unknown): string {
  const meta = (command as { meta?: unknown }).meta;
  if (!meta || typeof meta !== "object") return "";

  const description = (meta as { description?: unknown }).description;
  return typeof description === "string" ? description : "";
}

describe("CLI command categorization", () => {
  it("marks top-level commands as common, advanced, or integration", () => {
    expect(descriptionOf(setupCmd)).toContain("[legacy]");
    expect(descriptionOf(doctorCmd)).toContain("[common]");
    expect(descriptionOf(tickCmd)).toContain("[common]");
    expect(descriptionOf(runCmd)).toContain("[common]");
    expect(descriptionOf(statusCmd)).toContain("[common]");

    expect(descriptionOf(configCmd)).toContain("[legacy]");
    expect(descriptionOf(boardCmd)).toContain("[legacy]");
    expect(descriptionOf(factoryCmd)).toContain("[advanced]");

    expect(descriptionOf(integrationsCmd)).toContain("[integration]");
  });
});
