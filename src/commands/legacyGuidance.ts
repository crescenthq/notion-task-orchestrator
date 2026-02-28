const LIBRARY_FIRST_MIGRATION_STEPS = [
  "notionflow init",
  "notionflow factory create --id <name>",
  "notionflow doctor",
  "notionflow tick",
] as const;

export function printLegacyCommandGuidance(commandName: string): void {
  console.log(`[deprecated] \`notionflow ${commandName}\` is kept for compatibility and will be removed in a future release.`);
  console.log("Use the project-local, library-first flow instead:");
  for (const step of LIBRARY_FIRST_MIGRATION_STEPS) {
    console.log(`  ${step}`);
  }
  console.log("");
}
