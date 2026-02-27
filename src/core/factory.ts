import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ZodError } from "zod";
import { factorySchema, type FactoryDefinition } from "./factorySchema";

const RUNTIME_SLOT_REGEX = /\b(agent|select|until)\s*:\s*([A-Za-z_$][\w$]*)\b/g;
const IMPORT_REGEX = /^\s*import\s+([^;]+?)\s+from\s+["'][^"']+["']/gm;

function collectImportedIdentifiers(sourceText: string): Set<string> {
  const identifiers = new Set<string>();

  for (const match of sourceText.matchAll(IMPORT_REGEX)) {
    const clause = match[1]?.trim();
    if (!clause) continue;

    const normalized = clause.replace(/\s+/g, " ").trim();

    if (!normalized.startsWith("{")) {
      const defaultPart = normalized.split(",")[0]?.trim();
      if (defaultPart && defaultPart !== "*") identifiers.add(defaultPart);
    }

    const namedMatch = normalized.match(/\{([^}]+)\}/);
    if (namedMatch?.[1]) {
      const named = namedMatch[1]
        .split(",")
        .map((segment) => segment.trim())
        .filter(Boolean);
      for (const entry of named) {
        const [, alias = ""] = entry.split(/\s+as\s+/);
        identifiers.add((alias || entry).trim());
      }
    }

    const namespaceMatch = normalized.match(/\*\s+as\s+([A-Za-z_$][\w$]*)/);
    if (namespaceMatch?.[1]) identifiers.add(namespaceMatch[1]);
  }

  return identifiers;
}

function formatDiagnostic(filePath: string, messages: string[]): Error {
  return new Error(
    [
      `Invalid factory module: ${filePath}`,
      ...messages.map((message) => `- ${message}`),
    ].join("\n"),
  );
}

function formatZodError(filePath: string, error: ZodError): Error {
  const messages = error.issues.map((issue) => {
    const pathLabel = issue.path.length === 0 ? "<root>" : issue.path.join(".");
    return `${pathLabel}: ${issue.message}`;
  });
  return formatDiagnostic(filePath, messages);
}

export function assertFactoryRuntimeFunctionsAreLocal(sourceText: string, filePath: string): void {
  const importedIdentifiers = collectImportedIdentifiers(sourceText);
  if (importedIdentifiers.size === 0) return;

  const violations = new Set<string>();

  for (const match of sourceText.matchAll(RUNTIME_SLOT_REGEX)) {
    const slot = match[1];
    const identifier = match[2];
    if (!slot || !identifier) continue;
    if (importedIdentifiers.has(identifier)) {
      violations.add(`Imported function \`${identifier}\` cannot be used as runtime \`${slot}\``);
    }
  }

  if (violations.size > 0) {
    throw formatDiagnostic(filePath, [
      ...violations,
      "Runtime hooks (`agent`, `select`, `until`) must be inline or declared in the same factory file.",
    ]);
  }
}

export async function loadFactoryFromPath(inputPath: string): Promise<{ definition: FactoryDefinition; sourcePath: string; sourceText: string }> {
  const sourcePath = path.resolve(inputPath);
  const sourceText = await readFile(sourcePath, "utf8");

  assertFactoryRuntimeFunctionsAreLocal(sourceText, sourcePath);

  const moduleUrl = pathToFileURL(sourcePath);
  moduleUrl.searchParams.set("nf", String(Date.now()));

  const mod = await import(moduleUrl.href);
  const maybeFactory = (mod as { default?: unknown }).default;

  if (!maybeFactory || typeof maybeFactory !== "object") {
    throw formatDiagnostic(sourcePath, ["Module must export a factory object as default export"]);
  }

  try {
    const definition = factorySchema.parse(maybeFactory);
    return { definition, sourcePath, sourceText };
  } catch (error) {
    if (error instanceof ZodError) throw formatZodError(sourcePath, error);
    throw error;
  }
}

export function serializeFactoryDefinition(definition: FactoryDefinition): string {
  return JSON.stringify(
    definition,
    (_key, value) => {
      if (typeof value === "function") {
        return `[Function:${value.name || "anonymous"}]`;
      }
      return value;
    },
    2,
  );
}
