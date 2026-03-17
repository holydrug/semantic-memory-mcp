import { readdir, stat, readFile } from "node:fs/promises";
import { basename, join, relative } from "node:path";

import {
  type Strategy,
  type IngestionSource,
  classifyFile,
  assignPhase,
  assignScope,
  isExcluded,
  isGeneratedCode,
  isFileTooSmallOrLarge,
  isOpenApiSpec,
  prioritizeFiles,
} from "./classifier.js";

// Re-export types for consumers
export type { Strategy, IngestionSource };

// ── Types ──────────────────────────────────────────────────────────────────

export interface ScanResult {
  root: string;
  projectType: "monorepo" | "single" | "docs-only";
  sources: IngestionSource[];
  excluded: string[];
}

// ── Project markers ────────────────────────────────────────────────────────

const PROJECT_MARKERS = new Set([
  "package.json",
  "go.mod",
  "build.gradle.kts",
  "pom.xml",
  "Cargo.toml",
  "pyproject.toml",
]);

const SLN_EXT = ".sln";

function isProjectMarker(name: string): boolean {
  return PROJECT_MARKERS.has(name) || name.endsWith(SLN_EXT);
}

// ── Scanner ────────────────────────────────────────────────────────────────

/**
 * Walk a directory tree, detect projects, classify files into ingestion sources.
 * Pure Node.js; no external dependencies.
 */
export async function scanDirectory(root: string): Promise<ScanResult> {
  const excluded: string[] = [];

  // Maps: sub-project path → list of classified file entries
  const projectFiles = new Map<string, { file: string; strategy: Strategy }[]>();
  // Track detected project marker locations (absolute paths of dirs containing markers)
  const markerDirs = new Set<string>();
  // Root-level files (not inside any sub-project)
  const rootFiles: { file: string; strategy: Strategy }[] = [];

  // ── Recursive walk ─────────────────────────────────────────────────────
  await walk(root, root, excluded, markerDirs, projectFiles, rootFiles);

  // ── Determine project type ─────────────────────────────────────────────
  // Only count markers in *immediate subdirectories* (depth 1) — not root itself — for monorepo detection.
  const subProjectDirs = new Set<string>();
  for (const dir of markerDirs) {
    if (dir !== root) {
      subProjectDirs.add(dir);
    }
  }

  let projectType: ScanResult["projectType"];
  if (subProjectDirs.size >= 2) {
    projectType = "monorepo";
  } else if (subProjectDirs.size === 1 || markerDirs.has(root)) {
    projectType = "single";
  } else {
    // Check if we have any docs
    const anyDocs = rootFiles.some(
      (f) => f.strategy === "documentation" || f.strategy === "changelog" || f.strategy === "pdf",
    );
    projectType = anyDocs ? "docs-only" : "single";
  }

  // ── Build sources ──────────────────────────────────────────────────────
  const sources: IngestionSource[] = [];

  // Group root-level files by strategy
  const rootByStrategy = groupByStrategy(rootFiles);
  for (const [strategy, files] of rootByStrategy) {
    const prioritized = prioritizeFiles(files);
    const src: IngestionSource = {
      name: basename(root),
      path: root,
      strategy,
      phase: 1, // placeholder
      scope: "global", // placeholder
      files: prioritized,
    };
    src.phase = assignPhase(src);
    src.scope = assignScope(src, root);
    sources.push(src);
  }

  // Sub-project sources
  for (const [projPath, entries] of projectFiles) {
    const byStrategy = groupByStrategy(entries);
    for (const [strategy, files] of byStrategy) {
      const prioritized = prioritizeFiles(files);
      const src: IngestionSource = {
        name: basename(projPath),
        path: projPath,
        strategy,
        phase: 1, // placeholder
        scope: "project", // placeholder
        files: prioritized,
      };
      src.phase = assignPhase(src);
      src.scope = assignScope(src, root);
      sources.push(src);
    }
  }

  // Sort by phase, then by name for deterministic output
  sources.sort((a, b) => a.phase - b.phase || a.name.localeCompare(b.name));

  return { root, projectType, sources, excluded };
}

// ── Walk helper ────────────────────────────────────────────────────────────

async function walk(
  dir: string,
  root: string,
  excluded: string[],
  markerDirs: Set<string>,
  projectFiles: Map<string, { file: string; strategy: Strategy }[]>,
  rootFiles: { file: string; strategy: Strategy }[],
): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    excluded.push(`Cannot read directory: ${dir}`);
    return;
  }

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    const relPath = relative(root, fullPath);

    if (entry.isDirectory()) {
      if (isExcluded(fullPath, relPath)) {
        excluded.push(`Excluded directory: ${relPath}`);
        continue;
      }
      await walk(fullPath, root, excluded, markerDirs, projectFiles, rootFiles);
    } else if (entry.isFile()) {
      // Check exclusion
      if (isExcluded(fullPath, relPath)) {
        continue;
      }

      // Check size
      try {
        const st = await stat(fullPath);
        if (isFileTooSmallOrLarge(st.size)) {
          continue;
        }
      } catch {
        continue;
      }

      // Check generated code (read first line)
      let firstLine: string | undefined;
      try {
        const buf = await readFile(fullPath, { encoding: "utf-8", flag: "r" });
        firstLine = buf.slice(0, buf.indexOf("\n") === -1 ? 256 : buf.indexOf("\n")).slice(0, 256);
      } catch {
        // Cannot read — skip
        continue;
      }

      if (isGeneratedCode(relPath, firstLine)) {
        excluded.push(`Generated code: ${relPath}`);
        continue;
      }

      // Check for project marker
      if (isProjectMarker(entry.name)) {
        markerDirs.add(dir);
      }

      // Classify
      let strategy = classifyFile(fullPath);

      // Special handling for yaml/json — check if OpenAPI
      if (strategy === null) {
        const ext = entry.name.split(".").pop()?.toLowerCase();
        if (ext === "yaml" || ext === "yml" || ext === "json") {
          if (isOpenApiSpec(fullPath)) {
            strategy = "api-contracts";
          }
        }
      }

      if (strategy === null) continue;

      // Determine which project this file belongs to
      const projectDir = findProjectDir(dir, root, markerDirs);

      if (projectDir && projectDir !== root) {
        if (!projectFiles.has(projectDir)) {
          projectFiles.set(projectDir, []);
        }
        projectFiles.get(projectDir)!.push({ file: fullPath, strategy });
      } else {
        rootFiles.push({ file: fullPath, strategy });
      }
    }
  }
}

/**
 * Walk up from dir to root looking for a project marker directory.
 * Returns the closest ancestor (or dir itself) that is a marker dir, or null.
 */
function findProjectDir(
  dir: string,
  root: string,
  markerDirs: Set<string>,
): string | null {
  let current = dir;
  while (current.length >= root.length) {
    if (markerDirs.has(current)) return current;
    const parent = join(current, "..");
    if (parent === current) break;
    current = parent;
  }
  return null;
}

/**
 * Group file entries by strategy.
 */
function groupByStrategy(
  entries: { file: string; strategy: Strategy }[],
): Map<Strategy, string[]> {
  const map = new Map<Strategy, string[]>();
  for (const e of entries) {
    if (!map.has(e.strategy)) {
      map.set(e.strategy, []);
    }
    map.get(e.strategy)!.push(e.file);
  }
  return map;
}
