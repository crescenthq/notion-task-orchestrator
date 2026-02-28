import path from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { loadFactoryFromPath } from "../core/factory";
import type { FactoryDefinition } from "../core/factorySchema";

const projectConfigSchema = z.object({
  factories: z.array(z.string().min(1)).default([]),
});

export type ProjectConfig = z.infer<typeof projectConfigSchema>;

export type LoadedDeclaredFactory = {
  declaredPath: string;
  resolvedPath: string;
  definition: FactoryDefinition;
};

export class ProjectConfigLoadError extends Error {
  readonly configPath: string;

  constructor(message: string, configPath: string) {
    super(message);
    this.name = "ProjectConfigLoadError";
    this.configPath = configPath;
  }
}

export function defineConfig(config: ProjectConfig): ProjectConfig {
  return config;
}

export async function loadProjectConfig(configPath: string): Promise<ProjectConfig> {
  const resolvedConfigPath = path.resolve(configPath);
  const configModuleUrl = pathToFileURL(resolvedConfigPath);
  configModuleUrl.searchParams.set("nf", String(Date.now()));

  let loaded: unknown;
  try {
    const mod = await import(configModuleUrl.href);
    loaded = (mod as { default?: unknown }).default;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new ProjectConfigLoadError(
      `Failed to load project config module: ${resolvedConfigPath}\n${reason}`,
      resolvedConfigPath,
    );
  }

  const parsed = projectConfigSchema.safeParse(loaded);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => {
        const issuePath = issue.path.length > 0 ? issue.path.join(".") : "<root>";
        return `${issuePath}: ${issue.message}`;
      })
      .join("\n");

    throw new ProjectConfigLoadError(
      `Invalid project config: ${resolvedConfigPath}\n${details}`,
      resolvedConfigPath,
    );
  }

  return parsed.data;
}

export function resolveFactoryPaths(config: ProjectConfig, projectRoot: string): string[] {
  return config.factories.map((factoryPath) =>
    path.isAbsolute(factoryPath) ? path.resolve(factoryPath) : path.resolve(projectRoot, factoryPath),
  );
}

export async function loadDeclaredFactories(options: {
  configPath: string;
  projectRoot: string;
}): Promise<LoadedDeclaredFactory[]> {
  const config = await loadProjectConfig(options.configPath);
  const resolvedFactoryPaths = resolveFactoryPaths(config, options.projectRoot);

  const loadedFactories: LoadedDeclaredFactory[] = [];
  for (const [index, resolvedPath] of resolvedFactoryPaths.entries()) {
    const declaredPath = config.factories[index] ?? resolvedPath;
    try {
      const loaded = await loadFactoryFromPath(resolvedPath);
      loadedFactories.push({
        declaredPath,
        resolvedPath,
        definition: loaded.definition,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new ProjectConfigLoadError(
        [
          `Failed loading declared factory path: ${declaredPath}`,
          `Resolved path: ${resolvedPath}`,
          reason,
        ].join("\n"),
        path.resolve(options.configPath),
      );
    }
  }

  return loadedFactories;
}
