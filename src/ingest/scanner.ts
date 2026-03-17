/**
 * Directory scanner — detects sources and classifies files.
 * Stub implementation for Step 13; full implementation in Step 11.
 */

import { readdirSync, statSync } from "node:fs";
import { join, extname, basename } from "node:path";
import type { ScanResult, SourceInfo } from "./types.js";

const IGNORED_DIRS = new Set([
  "node_modules", ".git", ".svn", ".hg", "dist", "build", "out",
  ".next", ".nuxt", ".cache", "__pycache__", ".gradle", "target",
  ".semantic-memory", ".idea", ".vscode",
]);

const DOC_EXTENSIONS = new Set([".md", ".mdx", ".txt", ".rst", ".adoc"]);
const CODE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".kt", ".java", ".go", ".py",
  ".rs", ".rb", ".cs", ".swift", ".scala", ".c", ".cpp", ".h",
]);
const CONFIG_EXTENSIONS = new Set([".json", ".yaml", ".yml", ".toml", ".xml"]);

function walkDir(dir: string, maxDepth: number = 10): string[] {
  const files: string[] = [];
  if (maxDepth <= 0) return files;

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return files;
  }

  for (const entry of entries) {
    if (entry.startsWith(".") && entry !== ".docs") continue;
    if (IGNORED_DIRS.has(entry)) continue;

    const fullPath = join(dir, entry);
    try {
      const stat = statSync(fullPath);
      if (stat.isDirectory()) {
        files.push(...walkDir(fullPath, maxDepth - 1));
      } else if (stat.isFile()) {
        files.push(fullPath);
      }
    } catch {
      // skip inaccessible files
    }
  }

  return files;
}

function classifyFile(filePath: string): string | null {
  const ext = extname(filePath).toLowerCase();
  const name = basename(filePath).toLowerCase();

  if (name === "changelog.md" || name === "changes.md" || name === "release-notes.md") {
    return "changelog";
  }
  if (DOC_EXTENSIONS.has(ext)) return "documentation";
  if (CODE_EXTENSIONS.has(ext)) return "code-analysis";
  if (name === "package.json" || name === "build.gradle.kts" || name === "pom.xml" ||
      name === "cargo.toml" || name === "go.mod" || name === "requirements.txt") {
    return "dependency-graph";
  }
  if (ext === ".proto" || ext === ".graphql" || ext === ".openapi") return "api-contracts";
  if (CONFIG_EXTENSIONS.has(ext)) return "config";

  return null;
}

function assignPhase(strategy: string): number {
  switch (strategy) {
    case "documentation": return 1;
    case "api-contracts": return 1;
    case "changelog": return 1;
    case "code-analysis": return 2;
    case "dependency-graph": return 3;
    case "config": return 3;
    default: return 4;
  }
}

/**
 * Scan a directory, classify files, and group them into sources.
 */
export function scanDirectory(root: string, sourceFilter?: string): ScanResult {
  const allFiles = walkDir(root);

  // Group files by parent directory name (as source) and strategy
  const sourceMap = new Map<string, { strategy: string; files: string[] }>();

  for (const file of allFiles) {
    const strategy = classifyFile(file);
    if (!strategy) continue;

    // Determine source name from relative path
    const relPath = file.slice(root.length + 1);
    const parts = relPath.split("/");
    const sourceName = parts.length > 1 ? parts[0]! : basename(root);

    if (sourceFilter && sourceName !== sourceFilter) continue;

    const key = `${sourceName}:${strategy}`;
    const existing = sourceMap.get(key);
    if (existing) {
      existing.files.push(file);
    } else {
      sourceMap.set(key, { strategy, files: [file] });
    }
  }

  const sources: SourceInfo[] = [];
  for (const [key, value] of sourceMap) {
    const name = key.split(":")[0]!;
    sources.push({
      name,
      strategy: value.strategy,
      phase: assignPhase(value.strategy),
      files: value.files,
    });
  }

  // Sort by phase, then alphabetically
  sources.sort((a, b) => a.phase - b.phase || a.name.localeCompare(b.name));

  return { root, sources };
}
