import { access } from "node:fs/promises";
import path from "node:path";

const PROJECT_CONFIG_FILE = "notionflow.config.ts";

export type ResolvedProjectConfig = {
  projectRoot: string;
  configPath: string;
};

export async function discoverProjectConfig(startDir: string = process.cwd()): Promise<ResolvedProjectConfig | null> {
  let currentDir = path.resolve(startDir);

  while (true) {
    const candidate = path.join(currentDir, PROJECT_CONFIG_FILE);
    if (await pathExists(candidate)) {
      return {
        projectRoot: currentDir,
        configPath: candidate,
      };
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      return null;
    }

    currentDir = parentDir;
  }
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}
