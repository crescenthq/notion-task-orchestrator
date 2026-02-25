import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { paths } from "./paths.js";

export type NotionFlowConfig = {
  notionApiKey?: string;
  workspacePageId?: string;
  defaultAgent?: string;
  defaultWorkflow?: string;
};

const DEFAULT_CONFIG: NotionFlowConfig = {
  defaultAgent: "openclaw",
  defaultWorkflow: "default-task",
};

const CONFIG_KEYS = ["notion-api-key", "workspace-page-id", "default-agent", "default-workflow"] as const;
export type ConfigKey = (typeof CONFIG_KEYS)[number];

export function isValidConfigKey(key: string): key is ConfigKey {
  return (CONFIG_KEYS as readonly string[]).includes(key);
}

function keyToField(key: ConfigKey): keyof NotionFlowConfig {
  const map: Record<ConfigKey, keyof NotionFlowConfig> = {
    "notion-api-key": "notionApiKey",
    "workspace-page-id": "workspacePageId",
    "default-agent": "defaultAgent",
    "default-workflow": "defaultWorkflow",
  };
  return map[key];
}

export async function loadConfig(): Promise<NotionFlowConfig> {
  try {
    const raw = await readFile(paths.config, "utf8");
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_CONFIG, ...parsed };
  } catch (err: any) {
    if (err?.code === "ENOENT") return { ...DEFAULT_CONFIG };
    throw err;
  }
}

export async function saveConfig(config: NotionFlowConfig): Promise<void> {
  await mkdir(path.dirname(paths.config), { recursive: true });
  await writeFile(paths.config, JSON.stringify(config, null, 2) + "\n", "utf8");
}

export async function getConfigValue(key: ConfigKey): Promise<string | undefined> {
  const config = await loadConfig();
  return config[keyToField(key)] ?? undefined;
}

export async function setConfigValue(key: ConfigKey, value: string): Promise<void> {
  const config = await loadConfig();
  (config as any)[keyToField(key)] = value;
  await saveConfig(config);
}
