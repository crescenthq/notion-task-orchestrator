import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadDeclaredFactories, loadProjectConfig, resolveFactoryPaths } from "./projectConfig";

const fixtures: string[] = [];

afterEach(async () => {
  while (fixtures.length > 0) {
    const fixturePath = fixtures.pop();
    if (!fixturePath) continue;
    await rm(fixturePath, { recursive: true, force: true });
  }
});

describe("projectConfig", () => {
  it("loads config and resolves declared relative and absolute factory paths", async () => {
    const projectRoot = await createFixture("notionflow-project-config-");
    const factoriesDir = path.join(projectRoot, "factories");
    await mkdir(factoriesDir, { recursive: true });

    const localFactoryPath = path.join(factoriesDir, "local.mjs");
    const absoluteFactoryPath = path.join(projectRoot, "absolute.mjs");
    await writeMinimalFactory(localFactoryPath, "local-factory");
    await writeMinimalFactory(absoluteFactoryPath, "absolute-factory");

    const configPath = path.join(projectRoot, "notionflow.config.ts");
    await writeFile(
      configPath,
      `export default { factories: ["./factories/local.mjs", ${JSON.stringify(absoluteFactoryPath)}] };\n`,
      "utf8",
    );

    const config = await loadProjectConfig(configPath);
    const resolvedFactoryPaths = resolveFactoryPaths(config, projectRoot);

    expect(resolvedFactoryPaths).toEqual([localFactoryPath, absoluteFactoryPath]);

    const loaded = await loadDeclaredFactories({ configPath, projectRoot });
    expect(loaded.map((entry) => entry.definition.id)).toEqual(["local-factory", "absolute-factory"]);
  });

  it("loads only config-declared factories and does not scan unlisted files", async () => {
    const projectRoot = await createFixture("notionflow-project-config-declared-");
    const factoriesDir = path.join(projectRoot, "factories");
    await mkdir(factoriesDir, { recursive: true });

    const listedFactoryPath = path.join(factoriesDir, "listed.mjs");
    const unlistedInvalidFactoryPath = path.join(factoriesDir, "unlisted-invalid.mjs");
    await writeMinimalFactory(listedFactoryPath, "listed-factory");
    await writeFile(unlistedInvalidFactoryPath, "export default { not: 'a-factory' };\n", "utf8");

    const configPath = path.join(projectRoot, "notionflow.config.ts");
    await writeFile(configPath, `export default { factories: ["./factories/listed.mjs"] };\n`, "utf8");

    const loaded = await loadDeclaredFactories({ configPath, projectRoot });
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.definition.id).toBe("listed-factory");
  });
});

async function createFixture(prefix: string): Promise<string> {
  const fixturePath = await mkdtemp(path.join(os.tmpdir(), prefix));
  fixtures.push(fixturePath);
  return fixturePath;
}

async function writeMinimalFactory(targetPath: string, id: string): Promise<void> {
  await writeFile(
    targetPath,
    [
      "const run = async () => ({ status: 'done', data: {} });",
      "",
      "export default {",
      `  id: ${JSON.stringify(id)},`,
      "  start: 'start',",
      "  states: {",
      "    start: { type: 'action', agent: run, on: { done: 'done', failed: 'failed' } },",
      "    done: { type: 'done' },",
      "    failed: { type: 'failed' },",
      "  },",
      "};",
      "",
    ].join("\n"),
    "utf8",
  );
}
