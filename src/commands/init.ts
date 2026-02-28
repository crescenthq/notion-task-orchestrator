import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { defineCommand } from "citty";

const CONFIG_FILE = "notionflow.config.ts";
const FACTORIES_DIR = "factories";
const RUNTIME_DIR = ".notionflow";
const GITIGNORE_FILE = ".gitignore";
const RUNTIME_GITIGNORE_ENTRY = ".notionflow/";

const DEFAULT_CONFIG_TEMPLATE = `import { defineConfig } from "notionflow";

export default defineConfig({
  factories: [],
});
`;

export const initCmd = defineCommand({
  meta: { name: "init", description: "[common] Initialize a local NotionFlow project" },
  async run() {
    const projectRoot = process.cwd();
    const configPath = path.join(projectRoot, CONFIG_FILE);
    const factoriesPath = path.join(projectRoot, FACTORIES_DIR);
    const runtimePath = path.join(projectRoot, RUNTIME_DIR);

    await mkdir(factoriesPath, { recursive: true });
    await mkdir(runtimePath, { recursive: true });
    await writeFile(configPath, DEFAULT_CONFIG_TEMPLATE, { encoding: "utf8", flag: "wx" }).catch(async (error) => {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        return;
      }

      throw error;
    });

    await ensureRuntimeDirGitIgnored(path.join(projectRoot, GITIGNORE_FILE));

    console.log("NotionFlow project initialized");
    console.log(`Project root: ${projectRoot}`);
    console.log(`Config: ${configPath}`);
  },
});

async function ensureRuntimeDirGitIgnored(gitignorePath: string): Promise<void> {
  let existing = "";
  try {
    existing = await readFile(gitignorePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  const normalizedLines = existing
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && line !== RUNTIME_GITIGNORE_ENTRY);

  normalizedLines.push(RUNTIME_GITIGNORE_ENTRY);

  const uniqueLines = Array.from(new Set(normalizedLines));
  const nextContent = `${uniqueLines.join("\n")}\n`;
  await writeFile(gitignorePath, nextContent, "utf8");
}
