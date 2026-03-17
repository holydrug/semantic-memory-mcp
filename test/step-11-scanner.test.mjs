import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Import from compiled output
import {
  classifyFile,
  assignPhase,
  assignScope,
  isExcluded,
  isGeneratedCode,
  isOpenApiSpec,
  isFileTooSmallOrLarge,
  prioritizeFiles,
} from "../dist/ingest/classifier.js";

import { scanDirectory } from "../dist/ingest/scanner.js";

// ── Helpers ────────────────────────────────────────────────────────────────

function createTmpDir() {
  return mkdtempSync(join(tmpdir(), "sm-test-11-"));
}

function writeFile(dir, relPath, content = "x".repeat(100)) {
  const full = join(dir, relPath);
  const parent = join(full, "..");
  mkdirSync(parent, { recursive: true });
  writeFileSync(full, content, "utf-8");
  return full;
}

// ── Unit tests: classifyFile ───────────────────────────────────────────────

describe("classifyFile", () => {
  it('classifies .md as "documentation"', () => {
    assert.strictEqual(classifyFile("docs/api.md"), "documentation");
  });

  it('classifies .rst as "documentation"', () => {
    assert.strictEqual(classifyFile("docs/guide.rst"), "documentation");
  });

  it('classifies .ts as "code-analysis"', () => {
    assert.strictEqual(classifyFile("src/main.ts"), "code-analysis");
  });

  it('classifies .py as "code-analysis"', () => {
    assert.strictEqual(classifyFile("src/app.py"), "code-analysis");
  });

  it('classifies .proto as "api-contracts"', () => {
    assert.strictEqual(classifyFile("api/service.proto"), "api-contracts");
  });

  it('classifies .graphql as "api-contracts"', () => {
    assert.strictEqual(classifyFile("schema.graphql"), "api-contracts");
  });

  it('classifies build.gradle.kts as "dependency-graph"', () => {
    assert.strictEqual(classifyFile("build.gradle.kts"), "dependency-graph");
  });

  it('classifies package.json as "dependency-graph"', () => {
    assert.strictEqual(classifyFile("package.json"), "dependency-graph");
  });

  it('classifies pom.xml as "dependency-graph"', () => {
    assert.strictEqual(classifyFile("pom.xml"), "dependency-graph");
  });

  it('classifies CHANGELOG.md as "changelog"', () => {
    assert.strictEqual(classifyFile("CHANGELOG.md"), "changelog");
  });

  it('classifies changelog.md (lowercase) as "changelog"', () => {
    assert.strictEqual(classifyFile("changelog.md"), "changelog");
  });

  it("returns null for image files", () => {
    assert.strictEqual(classifyFile("image.png"), null);
  });

  it("returns null for binary files", () => {
    assert.strictEqual(classifyFile("file.exe"), null);
  });

  it('classifies .pdf as "pdf"', () => {
    assert.strictEqual(classifyFile("docs/manual.pdf"), "pdf");
  });

  it('classifies .go as "code-analysis"', () => {
    assert.strictEqual(classifyFile("cmd/main.go"), "code-analysis");
  });

  it('classifies .rs as "code-analysis"', () => {
    assert.strictEqual(classifyFile("src/lib.rs"), "code-analysis");
  });

  it('classifies go.mod as "dependency-graph"', () => {
    assert.strictEqual(classifyFile("go.mod"), "dependency-graph");
  });

  it('classifies Cargo.toml as "dependency-graph"', () => {
    assert.strictEqual(classifyFile("Cargo.toml"), "dependency-graph");
  });
});

// ── Unit tests: isExcluded ─────────────────────────────────────────────────

describe("isExcluded", () => {
  it("excludes node_modules paths", () => {
    assert.strictEqual(isExcluded("node_modules/foo.js"), true);
  });

  it("excludes build directory", () => {
    assert.strictEqual(isExcluded("build/output.js"), true);
  });

  it("excludes dist directory", () => {
    assert.strictEqual(isExcluded("dist/index.js"), true);
  });

  it("excludes .git directory", () => {
    assert.strictEqual(isExcluded(".git/HEAD"), true);
  });

  it("excludes test files", () => {
    assert.strictEqual(isExcluded("src/foo.spec.ts"), true);
    assert.strictEqual(isExcluded("src/bar.test.js"), true);
  });

  it("excludes lock files", () => {
    assert.strictEqual(isExcluded("package-lock.lock"), true);
  });

  it("does not exclude regular source files", () => {
    assert.strictEqual(isExcluded("src/main.ts"), false);
  });

  it("does not exclude docs", () => {
    assert.strictEqual(isExcluded("docs/readme.md"), false);
  });

  it("excludes vendor directory", () => {
    assert.strictEqual(isExcluded("vendor/lib/foo.go"), true);
  });

  it("excludes __pycache__ directory", () => {
    assert.strictEqual(isExcluded("__pycache__/mod.pyc"), true);
  });

  it("excludes generated directories", () => {
    assert.strictEqual(isExcluded("generated/types.ts"), true);
    assert.strictEqual(isExcluded("__generated__/schema.ts"), true);
  });
});

// ── Unit tests: isGeneratedCode ────────────────────────────────────────────

describe("isGeneratedCode", () => {
  it("detects AUTO-GENERATED marker", () => {
    assert.strictEqual(isGeneratedCode("file.ts", "// AUTO-GENERATED"), true);
  });

  it("detects DO NOT EDIT marker", () => {
    assert.strictEqual(isGeneratedCode("file.go", "// DO NOT EDIT"), true);
  });

  it("detects @Generated marker", () => {
    assert.strictEqual(isGeneratedCode("file.java", "// @Generated"), true);
  });

  it("returns false for normal first line", () => {
    assert.strictEqual(isGeneratedCode("file.ts", "import express from 'express';"), false);
  });

  it("detects generated directory path", () => {
    assert.strictEqual(isGeneratedCode("codegen/types.ts"), true);
  });

  it("returns false for normal file without first line", () => {
    assert.strictEqual(isGeneratedCode("src/main.ts"), false);
  });
});

// ── Unit tests: assignPhase ────────────────────────────────────────────────

describe("assignPhase", () => {
  it("docs source → phase 1", () => {
    assert.strictEqual(
      assignPhase({ strategy: "documentation", name: "docs" }),
      1,
    );
  });

  it("api-contracts source → phase 1", () => {
    assert.strictEqual(
      assignPhase({ strategy: "api-contracts", name: "api" }),
      1,
    );
  });

  it("changelog → phase 1", () => {
    assert.strictEqual(
      assignPhase({ strategy: "changelog", name: "root" }),
      1,
    );
  });

  it("pdf → phase 1", () => {
    assert.strictEqual(
      assignPhase({ strategy: "pdf", name: "manuals" }),
      1,
    );
  });

  it("common-lib → phase 2", () => {
    assert.strictEqual(
      assignPhase({ strategy: "code-analysis", name: "common-lib" }),
      2,
    );
  });

  it("platform-core → phase 2", () => {
    assert.strictEqual(
      assignPhase({ strategy: "code-analysis", name: "platform-core" }),
      2,
    );
  });

  it("auth-sdk-js → phase 2", () => {
    assert.strictEqual(
      assignPhase({ strategy: "code-analysis", name: "auth-sdk-js" }),
      2,
    );
  });

  it("auth-service → phase 3", () => {
    assert.strictEqual(
      assignPhase({ strategy: "code-analysis", name: "auth-service" }),
      3,
    );
  });

  it("dependency-graph → phase 4", () => {
    assert.strictEqual(
      assignPhase({ strategy: "dependency-graph", name: "root" }),
      4,
    );
  });
});

// ── Unit tests: assignScope ────────────────────────────────────────────────

describe("assignScope", () => {
  const root = "/project";

  it("common-lib → global", () => {
    assert.strictEqual(
      assignScope(
        { name: "common-lib", path: "/project/common-lib", strategy: "code-analysis" },
        root,
      ),
      "global",
    );
  });

  it("platform-core → global", () => {
    assert.strictEqual(
      assignScope(
        { name: "platform-core", path: "/project/platform-core", strategy: "code-analysis" },
        root,
      ),
      "global",
    );
  });

  it("auth-service → project", () => {
    assert.strictEqual(
      assignScope(
        { name: "auth-service", path: "/project/auth-service", strategy: "code-analysis" },
        root,
      ),
      "project",
    );
  });

  it("root docs → global", () => {
    assert.strictEqual(
      assignScope(
        { name: "docs", path: "/project", strategy: "documentation" },
        root,
      ),
      "global",
    );
  });

  it("changelog → global", () => {
    assert.strictEqual(
      assignScope(
        { name: "root", path: "/project", strategy: "changelog" },
        root,
      ),
      "global",
    );
  });
});

// ── Unit tests: isOpenApiSpec ──────────────────────────────────────────────

describe("isOpenApiSpec", () => {
  let tmpDir;

  before(() => {
    tmpDir = createTmpDir();
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("detects openapi yaml", () => {
    const f = writeFile(tmpDir, "api.yaml", 'openapi: "3.0.0"\ninfo:\n  title: Test');
    assert.strictEqual(isOpenApiSpec(f), true);
  });

  it("detects swagger json", () => {
    const f = writeFile(tmpDir, "api.json", '{ "swagger": "2.0", "info": {} }');
    assert.strictEqual(isOpenApiSpec(f), true);
  });

  it("rejects non-openapi yaml", () => {
    const f = writeFile(tmpDir, "config.yaml", "database:\n  host: localhost");
    assert.strictEqual(isOpenApiSpec(f), false);
  });

  it("rejects non-yaml/json files", () => {
    const f = writeFile(tmpDir, "readme.md", "# Hello");
    assert.strictEqual(isOpenApiSpec(f), false);
  });
});

// ── Unit tests: isFileTooSmallOrLarge ──────────────────────────────────────

describe("isFileTooSmallOrLarge", () => {
  it("skips tiny files (<50b)", () => {
    assert.strictEqual(isFileTooSmallOrLarge(10), true);
  });

  it("skips large files (>50KB)", () => {
    assert.strictEqual(isFileTooSmallOrLarge(60 * 1024), true);
  });

  it("accepts normal sized files", () => {
    assert.strictEqual(isFileTooSmallOrLarge(500), false);
  });

  it("accepts boundary size (50b)", () => {
    assert.strictEqual(isFileTooSmallOrLarge(50), false);
  });

  it("accepts boundary size (50KB)", () => {
    assert.strictEqual(isFileTooSmallOrLarge(50 * 1024), false);
  });
});

// ── Unit tests: prioritizeFiles ────────────────────────────────────────────

describe("prioritizeFiles", () => {
  it("returns all files when <= 100", () => {
    const files = Array.from({ length: 50 }, (_, i) => `file${i}.ts`);
    assert.strictEqual(prioritizeFiles(files).length, 50);
  });

  it("filters to priority files when > 100", () => {
    const files = [
      ...Array.from({ length: 101 }, (_, i) => `model${i}.ts`),
      "UserController.ts",
      "AuthService.ts",
      "ApiHandler.ts",
    ];
    const result = prioritizeFiles(files);
    assert.ok(result.length <= files.length);
    assert.ok(result.includes("UserController.ts"));
    assert.ok(result.includes("AuthService.ts"));
    assert.ok(result.includes("ApiHandler.ts"));
  });

  it("returns first 100 when no priority files in large module", () => {
    const files = Array.from({ length: 150 }, (_, i) => `data${i}.dat`);
    assert.strictEqual(prioritizeFiles(files).length, 100);
  });
});

// ── Integration tests: scanDirectory ───────────────────────────────────────

describe("scanDirectory (integration)", { skip: !process.env.INTEGRATION }, () => {
  let tmpDir;

  before(() => {
    tmpDir = createTmpDir();
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("scans monorepo structure correctly", async () => {
    // Create monorepo structure
    // .docs/ with 5 .md files
    for (let i = 0; i < 5; i++) {
      writeFile(tmpDir, `.docs/doc${i}.md`, "# Documentation\n" + "x".repeat(100));
    }
    // api/ with 3 .proto files
    for (let i = 0; i < 3; i++) {
      writeFile(tmpDir, `api/service${i}.proto`, 'syntax = "proto3";\n' + "x".repeat(100));
    }
    // auth-service/ with package.json + 10 .ts files
    writeFile(tmpDir, "auth-service/package.json", '{ "name": "auth-service" }\n' + "x".repeat(100));
    for (let i = 0; i < 10; i++) {
      writeFile(tmpDir, `auth-service/src/file${i}.ts`, 'export function handler() {}\n' + "x".repeat(100));
    }
    // common-lib/ with package.json + 5 .ts files
    writeFile(tmpDir, "common-lib/package.json", '{ "name": "common-lib" }\n' + "x".repeat(100));
    for (let i = 0; i < 5; i++) {
      writeFile(tmpDir, `common-lib/src/file${i}.ts`, 'export function util() {}\n' + "x".repeat(100));
    }
    // node_modules/ (should be excluded)
    writeFile(tmpDir, "node_modules/foo/index.js", 'module.exports = {};\n' + "x".repeat(100));
    // build/ (should be excluded)
    writeFile(tmpDir, "build/output.js", 'console.log("built");\n' + "x".repeat(100));

    const result = await scanDirectory(tmpDir);

    assert.strictEqual(result.root, tmpDir);
    assert.strictEqual(result.projectType, "monorepo");
    assert.ok(result.sources.length >= 4, `Expected at least 4 sources, got ${result.sources.length}`);

    // Check node_modules and build excluded
    assert.ok(
      result.excluded.some((e) => e.includes("node_modules")),
      "node_modules should be excluded",
    );
    assert.ok(
      result.excluded.some((e) => e.includes("build")),
      "build should be excluded",
    );

    // Check strategies
    const strategies = new Set(result.sources.map((s) => s.strategy));
    assert.ok(strategies.has("documentation"), "Should have documentation strategy");
    assert.ok(strategies.has("api-contracts"), "Should have api-contracts strategy");
    assert.ok(strategies.has("code-analysis"), "Should have code-analysis strategy");

    // Check phases
    const docSource = result.sources.find((s) => s.strategy === "documentation");
    assert.ok(docSource);
    assert.strictEqual(docSource.phase, 1);

    const commonLib = result.sources.find(
      (s) => s.name === "common-lib" && s.strategy === "code-analysis",
    );
    assert.ok(commonLib, "Should have common-lib source");
    assert.strictEqual(commonLib.phase, 2);
    assert.strictEqual(commonLib.scope, "global");

    const authService = result.sources.find(
      (s) => s.name === "auth-service" && s.strategy === "code-analysis",
    );
    assert.ok(authService, "Should have auth-service source");
    assert.strictEqual(authService.phase, 3);
    assert.strictEqual(authService.scope, "project");
  });

  it("returns empty sources for empty directory", async () => {
    const emptyDir = createTmpDir();
    try {
      const result = await scanDirectory(emptyDir);
      assert.strictEqual(result.sources.length, 0);
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  it("excludes node_modules from scan", async () => {
    const dir = createTmpDir();
    try {
      writeFile(dir, "src/main.ts", 'export const x = 1;\n' + "x".repeat(100));
      writeFile(dir, "node_modules/dep/index.js", 'module.exports = {};\n' + "x".repeat(100));

      const result = await scanDirectory(dir);

      // No source should contain node_modules files
      for (const src of result.sources) {
        for (const f of src.files) {
          assert.ok(
            !f.includes("node_modules"),
            `File ${f} should not be in sources`,
          );
        }
      }
      assert.ok(
        result.excluded.some((e) => e.includes("node_modules")),
        "node_modules should appear in excluded list",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("detects single project correctly", async () => {
    const dir = createTmpDir();
    try {
      writeFile(dir, "package.json", '{ "name": "my-app" }\n' + "x".repeat(100));
      writeFile(dir, "src/index.ts", 'console.log("hello");\n' + "x".repeat(100));
      writeFile(dir, "src/utils.ts", 'export const util = 1;\n' + "x".repeat(100));

      const result = await scanDirectory(dir);
      assert.strictEqual(result.projectType, "single");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("detects docs-only project", async () => {
    const dir = createTmpDir();
    try {
      writeFile(dir, "README.md", "# Project\n" + "x".repeat(100));
      writeFile(dir, "docs/guide.md", "# Guide\n" + "x".repeat(100));

      const result = await scanDirectory(dir);
      assert.strictEqual(result.projectType, "docs-only");
      assert.ok(result.sources.length > 0, "Should have doc sources");
      assert.ok(
        result.sources.every((s) => s.strategy === "documentation"),
        "All sources should be documentation",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("excludes generated code with markers", async () => {
    const dir = createTmpDir();
    try {
      writeFile(dir, "src/main.ts", 'export const x = 1;\n' + "x".repeat(100));
      writeFile(dir, "src/generated.ts", "// AUTO-GENERATED\nexport const y = 2;\n" + "x".repeat(100));

      const result = await scanDirectory(dir);
      const allFiles = result.sources.flatMap((s) => s.files);
      assert.ok(
        !allFiles.some((f) => f.includes("generated.ts")),
        "Generated file should be excluded",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("detects OpenAPI yaml as api-contracts", async () => {
    const dir = createTmpDir();
    try {
      writeFile(dir, "api.yaml", 'openapi: "3.0.0"\ninfo:\n  title: My API\n' + "x".repeat(100));

      const result = await scanDirectory(dir);
      const apiSource = result.sources.find((s) => s.strategy === "api-contracts");
      assert.ok(apiSource, "Should detect OpenAPI yaml as api-contracts");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
