import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function collectMarkdownFiles(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectMarkdownFiles(full));
    } else if (entry.name.endsWith(".md")) {
      files.push(full);
    }
  }
  return files;
}

const SCAN_DIRS = [
  path.join(repoRoot, "docs"),
  path.join(repoRoot, "skills"),
];

const FORBIDDEN_PATTERNS: { label: string; test: (line: string) => boolean }[] = [
  {
    label: "~/.config/notionflow global path",
    test: (line) => line.includes("~/.config/notionflow"),
  },
  {
    label: "factory install (deprecated command)",
    test: (line) => /\bfactory\s+install\b/.test(line),
  },
];

const CANONICAL_FILES: { file: string; requiredTerms: string[] }[] = [
  {
    file: path.join(repoRoot, "README.md"),
    requiredTerms: ["notionflow.config.ts", "--config"],
  },
  {
    file: path.join(repoRoot, "docs", "cli-reference.md"),
    requiredTerms: ["notionflow.config.ts", "--config"],
  },
  {
    file: path.join(repoRoot, "skills", "setup", "SKILL.md"),
    requiredTerms: ["notionflow.config.ts", "--config"],
  },
  {
    file: path.join(repoRoot, "skills", "add-factory", "SKILL.md"),
    requiredTerms: ["notionflow.config.ts", "--config"],
  },
];

describe("legacy-pattern guardrails", () => {
  it("docs and skills contain no forbidden global-mode patterns", () => {
    const files: string[] = [];
    for (const dir of SCAN_DIRS) {
      try {
        if (statSync(dir).isDirectory()) {
          files.push(...collectMarkdownFiles(dir));
        }
      } catch {
        // skip missing dirs
      }
    }
    // also scan README
    files.push(path.join(repoRoot, "README.md"));

    const violations: string[] = [];
    for (const filePath of files) {
      const lines = readFileSync(filePath, "utf8").split("\n");
      for (let i = 0; i < lines.length; i++) {
        for (const { label, test } of FORBIDDEN_PATTERNS) {
          if (test(lines[i])) {
            const rel = path.relative(repoRoot, filePath);
            violations.push(`  ${rel}:${i + 1} [${label}]\n    > ${lines[i].trim()}`);
          }
        }
      }
    }

    expect(
      violations,
      `Legacy global-mode patterns found in docs/skills:\n\n${violations.join("\n")}`
    ).toHaveLength(0);
  });

  it("canonical docs and skills contain required local-project terms", () => {
    const missing: string[] = [];
    for (const { file, requiredTerms } of CANONICAL_FILES) {
      const content = readFileSync(file, "utf8");
      for (const term of requiredTerms) {
        if (!content.includes(term)) {
          const rel = path.relative(repoRoot, file);
          missing.push(`  ${rel}: missing required term "${term}"`);
        }
      }
    }

    expect(
      missing,
      `Canonical docs/skills missing required local-project terms:\n\n${missing.join("\n")}`
    ).toHaveLength(0);
  });
});
