import { basename, extname } from "node:path";
import { readFileSync } from "node:fs";

// ── Types ──────────────────────────────────────────────────────────────────

export type Strategy =
  | "documentation"
  | "pdf"
  | "api-contracts"
  | "code-analysis"
  | "changelog"
  | "dependency-graph";

export interface IngestionSource {
  name: string;
  path: string;
  strategy: Strategy;
  phase: 1 | 2 | 3 | 4;
  scope: "global" | "project";
  files: string[];
  context?: string;
}

// ── Exclusion patterns ─────────────────────────────────────────────────────

const EXCLUDED_DIRS = new Set([
  "node_modules",
  "build",
  "dist",
  "target",
  ".git",
  "vendor",
  "__pycache__",
  ".idea",
  ".vscode",
  ".DS_Store",
  "test",
  "tests",
  "__tests__",
  ".next",
  ".nuxt",
  "coverage",
]);

const EXCLUDED_EXTENSIONS = new Set([
  ".lock",
  ".min.js",
  ".map",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".svg",
  ".ico",
  ".woff",
  ".woff2",
  ".ttf",
  ".eot",
  ".mp3",
  ".mp4",
  ".avi",
  ".mov",
  ".zip",
  ".tar",
  ".gz",
  ".rar",
  ".7z",
  ".exe",
  ".dll",
  ".so",
  ".dylib",
  ".o",
  ".a",
  ".class",
  ".pyc",
  ".pyo",
  ".wasm",
]);

const EXCLUDED_SUFFIXES = [".spec.", ".test.", ".spec_", ".test_"];

const GENERATED_DIRS = new Set([
  "generated",
  "auto",
  "codegen",
  "__generated__",
]);

const GENERATED_MARKERS = ["DO NOT EDIT", "AUTO-GENERATED", "@Generated"];

// ── Size limits ────────────────────────────────────────────────────────────

const MIN_FILE_SIZE = 50;
const MAX_FILE_SIZE = 50 * 1024; // 50KB

// ── Strategy maps ──────────────────────────────────────────────────────────

const DOC_EXTENSIONS = new Set([".md", ".rst", ".adoc", ".html", ".txt"]);
const CODE_EXTENSIONS = new Set([
  ".kt",
  ".java",
  ".go",
  ".ts",
  ".py",
  ".rs",
  ".cs",
  ".tsx",
  ".jsx",
  ".js",
]);
const API_EXTENSIONS = new Set([".proto", ".graphql"]);
const DEPENDENCY_FILES = new Set([
  "build.gradle.kts",
  "pom.xml",
  "go.mod",
  "package.json",
  "Cargo.toml",
  "pyproject.toml",
]);

// ── Priority entry-point patterns for large modules ────────────────────────

const PRIORITY_PATTERNS = [
  /Controller/i,
  /Service/i,
  /Api/i,
  /Handler/i,
  /Router/i,
  /Config/i,
  /index\./i,
  /main\./i,
  /app\./i,
  /mod\./i,
];

// ── Shared-lib name patterns ───────────────────────────────────────────────

const SHARED_LIB_PATTERNS = [/^common-/i, /-sdk-/i, /^platform-/i];

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Determine the ingestion strategy for a file based on its path/name.
 * Returns null for unrecognised or binary files.
 */
export function classifyFile(filePath: string): Strategy | null {
  const base = basename(filePath);
  const ext = extname(filePath).toLowerCase();

  // Changelog detection (before general docs)
  if (/^changelog/i.test(base)) {
    return "changelog";
  }

  // Dependency graph files (exact basename match)
  if (DEPENDENCY_FILES.has(base)) {
    return "dependency-graph";
  }

  // *.sln is also dependency-graph
  if (ext === ".sln") {
    return "dependency-graph";
  }

  // PDF
  if (ext === ".pdf") {
    return "pdf";
  }

  // API contracts
  if (API_EXTENSIONS.has(ext)) {
    return "api-contracts";
  }

  // OpenAPI yaml/json (lightweight check by extension; deep check via isOpenApiSpec)
  if (ext === ".yaml" || ext === ".yml" || ext === ".json") {
    // We do NOT read the file here to stay fast; scanner does deeper checks.
    // Return null to let the scanner decide (or caller can use isOpenApiSpec).
    return null;
  }

  // Documentation
  if (DOC_EXTENSIONS.has(ext)) {
    return "documentation";
  }

  // Source code
  if (CODE_EXTENSIONS.has(ext)) {
    return "code-analysis";
  }

  return null;
}

/**
 * Assign execution phase to a source.
 */
export function assignPhase(source: Pick<IngestionSource, "strategy" | "name">): 1 | 2 | 3 | 4 {
  if (source.strategy === "documentation" || source.strategy === "api-contracts" || source.strategy === "pdf" || source.strategy === "changelog") {
    return 1;
  }

  if (source.strategy === "dependency-graph") {
    return 4;
  }

  // Shared libs → phase 2, services → phase 3
  if (isSharedLib(source.name)) {
    return 2;
  }

  return 3;
}

/**
 * Assign scope to a source.
 */
export function assignScope(source: Pick<IngestionSource, "name" | "path" | "strategy">, rootPath: string): "global" | "project" {
  // Root-level docs → global
  if (source.strategy === "documentation" || source.strategy === "changelog" || source.strategy === "pdf" || source.strategy === "api-contracts") {
    return "global";
  }

  // Shared libs → global
  if (isSharedLib(source.name)) {
    return "global";
  }

  return "project";
}

/**
 * Check whether a relative path should be excluded from scanning.
 */
export function isExcluded(filePath: string, _relativePath?: string): boolean {
  const rel = _relativePath ?? filePath;
  const parts = rel.split(/[\\/]/);
  const base = parts[parts.length - 1] ?? "";
  const ext = extname(base).toLowerCase();

  // Excluded directories
  for (const part of parts) {
    if (EXCLUDED_DIRS.has(part)) return true;
    if (GENERATED_DIRS.has(part)) return true;
  }

  // Excluded extensions
  if (EXCLUDED_EXTENSIONS.has(ext)) return true;

  // Test/spec files
  for (const suffix of EXCLUDED_SUFFIXES) {
    if (base.includes(suffix)) return true;
  }

  return false;
}

/**
 * Check whether a file is generated code (by path or first-line markers).
 */
export function isGeneratedCode(filePath: string, firstLine?: string): boolean {
  // Check directory path for generated dirs
  const parts = filePath.split(/[\\/]/);
  for (const part of parts) {
    if (GENERATED_DIRS.has(part)) return true;
  }

  // Check first-line markers
  if (firstLine) {
    for (const marker of GENERATED_MARKERS) {
      if (firstLine.includes(marker)) return true;
    }
  }

  return false;
}

/**
 * Check whether a YAML/JSON file looks like an OpenAPI spec.
 * Reads the first few bytes of the file to detect "openapi" or "swagger" top-level key.
 */
export function isOpenApiSpec(filePath: string): boolean {
  const ext = extname(filePath).toLowerCase();
  if (ext !== ".yaml" && ext !== ".yml" && ext !== ".json") return false;

  try {
    // Read just the first 512 bytes — enough to detect top-level key
    const fd = readFileSync(filePath, { encoding: "utf-8", flag: "r" });
    const head = fd.slice(0, 512).toLowerCase();
    return head.includes('"openapi"') || head.includes("openapi:") || head.includes('"swagger"') || head.includes("swagger:");
  } catch {
    return false;
  }
}

/**
 * Check file size constraints. Returns true if the file should be skipped.
 */
export function isFileTooSmallOrLarge(sizeBytes: number): boolean {
  return sizeBytes < MIN_FILE_SIZE || sizeBytes > MAX_FILE_SIZE;
}

/**
 * For large modules (>100 files), filter down to priority entry-point files.
 */
export function prioritizeFiles(files: string[]): string[] {
  if (files.length <= 100) return files;

  const priority = files.filter((f) => {
    const base = basename(f);
    return PRIORITY_PATTERNS.some((p) => p.test(base));
  });

  // If no priority files found, return original list (capped)
  return priority.length > 0 ? priority : files.slice(0, 100);
}

// ── Helpers ────────────────────────────────────────────────────────────────

function isSharedLib(name: string): boolean {
  return SHARED_LIB_PATTERNS.some((p) => p.test(name));
}
