import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ─── URL validation tests ───────────────────────────────────

describe("validateUrl", () => {
  /** @type {import('../dist/tools/ingest-url.js').validateUrl} */
  let validateUrl;

  beforeEach(async () => {
    const mod = await import("../dist/tools/ingest-url.js");
    validateUrl = mod.validateUrl;
  });

  it("accepts valid HTTP URL", () => {
    const result = validateUrl("http://example.com");
    assert.strictEqual(result, null);
  });

  it("accepts valid HTTPS URL", () => {
    const result = validateUrl("https://example.com/docs/changelog");
    assert.strictEqual(result, null);
  });

  it("rejects FTP URL", () => {
    const result = validateUrl("ftp://example.com/file");
    assert.ok(result !== null);
    assert.ok(result.includes("HTTP/HTTPS"));
  });

  it("rejects file:// URL", () => {
    const result = validateUrl("file:///etc/passwd");
    assert.ok(result !== null);
    assert.ok(result.includes("HTTP/HTTPS"));
  });

  it("rejects localhost", () => {
    const result = validateUrl("http://localhost:8080/api");
    assert.ok(result !== null);
    assert.ok(result.includes("localhost"));
  });

  it("rejects 127.0.0.1", () => {
    const result = validateUrl("http://127.0.0.1:3000");
    assert.ok(result !== null);
    assert.ok(result.includes("localhost") || result.includes("private"));
  });

  it("rejects 10.0.0.1 (private IP)", () => {
    const result = validateUrl("http://10.0.0.1/internal");
    assert.ok(result !== null);
    assert.ok(result.includes("private"));
  });

  it("rejects 172.16.0.1 (private IP)", () => {
    const result = validateUrl("http://172.16.0.1/api");
    assert.ok(result !== null);
    assert.ok(result.includes("private"));
  });

  it("rejects 192.168.0.1 (private IP)", () => {
    const result = validateUrl("http://192.168.0.1/api");
    assert.ok(result !== null);
    assert.ok(result.includes("private"));
  });

  it("accepts public IP", () => {
    const result = validateUrl("http://8.8.8.8/dns");
    assert.strictEqual(result, null);
  });

  it("rejects invalid URL", () => {
    const result = validateUrl("not-a-url");
    assert.ok(result !== null);
    assert.ok(result.includes("Invalid URL"));
  });
});

// ─── isPrivateIp tests ──────────────────────────────────────

describe("isPrivateIp", () => {
  /** @type {import('../dist/tools/ingest-url.js').isPrivateIp} */
  let isPrivateIp;

  beforeEach(async () => {
    const mod = await import("../dist/tools/ingest-url.js");
    isPrivateIp = mod.isPrivateIp;
  });

  it("detects 127.x.x.x as private", () => {
    assert.strictEqual(isPrivateIp("127.0.0.1"), true);
    assert.strictEqual(isPrivateIp("127.255.255.255"), true);
  });

  it("detects 10.x.x.x as private", () => {
    assert.strictEqual(isPrivateIp("10.0.0.1"), true);
    assert.strictEqual(isPrivateIp("10.255.255.255"), true);
  });

  it("detects 172.16-31.x.x as private", () => {
    assert.strictEqual(isPrivateIp("172.16.0.1"), true);
    assert.strictEqual(isPrivateIp("172.31.255.255"), true);
  });

  it("does NOT treat 172.15.x.x as private", () => {
    assert.strictEqual(isPrivateIp("172.15.0.1"), false);
  });

  it("does NOT treat 172.32.x.x as private", () => {
    assert.strictEqual(isPrivateIp("172.32.0.1"), false);
  });

  it("detects 192.168.x.x as private", () => {
    assert.strictEqual(isPrivateIp("192.168.0.1"), true);
    assert.strictEqual(isPrivateIp("192.168.255.255"), true);
  });

  it("does NOT treat 192.167.x.x as private", () => {
    assert.strictEqual(isPrivateIp("192.167.0.1"), false);
  });

  it("detects 0.0.0.0 as private", () => {
    assert.strictEqual(isPrivateIp("0.0.0.0"), true);
  });

  it("detects 169.254.x.x (link-local) as private", () => {
    assert.strictEqual(isPrivateIp("169.254.1.1"), true);
  });

  it("returns false for public IPs", () => {
    assert.strictEqual(isPrivateIp("8.8.8.8"), false);
    assert.strictEqual(isPrivateIp("1.1.1.1"), false);
    assert.strictEqual(isPrivateIp("93.184.216.34"), false);
  });

  it("returns false for hostnames (not IPs)", () => {
    assert.strictEqual(isPrivateIp("example.com"), false);
    assert.strictEqual(isPrivateIp("localhost"), false);
  });
});

// ─── IngestState management tests ───────────────────────────

describe("IngestState management", () => {
  /** @type {import('../dist/tools/ingest.js')._getRuns} */
  let _getRuns;
  /** @type {import('../dist/tools/ingest.js')._clearRuns} */
  let _clearRuns;

  beforeEach(async () => {
    const mod = await import("../dist/tools/ingest.js");
    _getRuns = mod._getRuns;
    _clearRuns = mod._clearRuns;
    _clearRuns();
  });

  afterEach(() => {
    _clearRuns();
  });

  it("starts with empty runs map", () => {
    const runs = _getRuns();
    assert.strictEqual(runs.size, 0);
  });

  it("can add and retrieve a run state", () => {
    const runs = _getRuns();
    /** @type {import('../dist/ingest/types.js').IngestState} */
    const state = {
      runId: "test-run-1",
      status: "running",
      startedAt: new Date().toISOString(),
      scanRoot: "/tmp/test",
      sources: {},
      cancelRequested: false,
      factsStored: 0,
      duplicatesSkipped: 0,
      errors: [],
    };
    runs.set("test-run-1", state);

    const retrieved = runs.get("test-run-1");
    assert.ok(retrieved);
    assert.strictEqual(retrieved.runId, "test-run-1");
    assert.strictEqual(retrieved.status, "running");
  });

  it("can update state: start -> running -> done", () => {
    const runs = _getRuns();
    /** @type {import('../dist/ingest/types.js').IngestState} */
    const state = {
      runId: "test-run-2",
      status: "running",
      startedAt: new Date().toISOString(),
      scanRoot: "/tmp/test",
      sources: {
        "my-source": {
          status: "pending",
          phase: 1,
          strategy: "documentation",
          filesTotal: 5,
          filesProcessed: 0,
          factsStored: 0,
          duplicatesSkipped: 0,
        },
      },
      cancelRequested: false,
      factsStored: 0,
      duplicatesSkipped: 0,
      errors: [],
    };
    runs.set("test-run-2", state);

    // Update source to in_progress
    state.sources["my-source"].status = "in_progress";
    state.sources["my-source"].filesProcessed = 3;

    let retrieved = runs.get("test-run-2");
    assert.strictEqual(retrieved.sources["my-source"].status, "in_progress");
    assert.strictEqual(retrieved.sources["my-source"].filesProcessed, 3);

    // Complete
    state.sources["my-source"].status = "done";
    state.sources["my-source"].filesProcessed = 5;
    state.sources["my-source"].factsStored = 12;
    state.status = "done";
    state.factsStored = 12;
    state.completedAt = new Date().toISOString();

    retrieved = runs.get("test-run-2");
    assert.strictEqual(retrieved.status, "done");
    assert.strictEqual(retrieved.factsStored, 12);
    assert.ok(retrieved.completedAt);
  });

  it("can cancel a running state", () => {
    const runs = _getRuns();
    /** @type {import('../dist/ingest/types.js').IngestState} */
    const state = {
      runId: "test-run-3",
      status: "running",
      startedAt: new Date().toISOString(),
      scanRoot: "/tmp/test",
      sources: {},
      cancelRequested: false,
      factsStored: 0,
      duplicatesSkipped: 0,
      errors: [],
    };
    runs.set("test-run-3", state);

    state.cancelRequested = true;
    const retrieved = runs.get("test-run-3");
    assert.strictEqual(retrieved.cancelRequested, true);
  });
});

// ─── Scanner tests ──────────────────────────────────────────

describe("scanDirectory", () => {
  let tmpDir;
  /** @type {import('../dist/ingest/scanner.js').scanDirectory} */
  let scanDirectory;

  beforeEach(async () => {
    const mod = await import("../dist/ingest/scanner.js");
    scanDirectory = mod.scanDirectory;
    tmpDir = mkdtempSync(join(tmpdir(), "scan-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns empty sources for empty directory", () => {
    const result = scanDirectory(tmpDir);
    assert.strictEqual(result.sources.length, 0);
    assert.strictEqual(result.root, tmpDir);
  });

  it("detects documentation files", () => {
    const docsDir = join(tmpDir, "docs");
    mkdirSync(docsDir);
    writeFileSync(join(docsDir, "README.md"), "# Hello");
    writeFileSync(join(docsDir, "guide.md"), "# Guide");

    const result = scanDirectory(tmpDir);
    assert.ok(result.sources.length > 0);
    const docSource = result.sources.find((s) => s.strategy === "documentation");
    assert.ok(docSource, "Should find documentation source");
    assert.strictEqual(docSource.files.length, 2);
  });

  it("detects code files", () => {
    const srcDir = join(tmpDir, "service");
    mkdirSync(srcDir);
    writeFileSync(join(srcDir, "main.ts"), "export function main() {}");
    writeFileSync(join(srcDir, "utils.ts"), "export function util() {}");

    const result = scanDirectory(tmpDir);
    const codeSource = result.sources.find((s) => s.strategy === "code-analysis");
    assert.ok(codeSource, "Should find code-analysis source");
    assert.strictEqual(codeSource.files.length, 2);
  });

  it("respects source filter", () => {
    const docsDir = join(tmpDir, "docs");
    const srcDir = join(tmpDir, "service");
    mkdirSync(docsDir);
    mkdirSync(srcDir);
    writeFileSync(join(docsDir, "README.md"), "# Hello");
    writeFileSync(join(srcDir, "main.ts"), "export function main() {}");

    const result = scanDirectory(tmpDir, "docs");
    assert.ok(result.sources.length > 0);
    for (const src of result.sources) {
      assert.strictEqual(src.name, "docs");
    }
  });

  it("ignores node_modules", () => {
    const nmDir = join(tmpDir, "node_modules", "pkg");
    mkdirSync(nmDir, { recursive: true });
    writeFileSync(join(nmDir, "index.js"), "module.exports = {};");

    const srcDir = join(tmpDir, "src");
    mkdirSync(srcDir);
    writeFileSync(join(srcDir, "app.ts"), "export const x = 1;");

    const result = scanDirectory(tmpDir);
    // node_modules files should not appear
    for (const src of result.sources) {
      for (const file of src.files) {
        assert.ok(!file.includes("node_modules"), `Should not include node_modules: ${file}`);
      }
    }
  });

  it("sorts sources by phase (docs before code)", () => {
    const docsDir = join(tmpDir, "docs");
    const srcDir = join(tmpDir, "service");
    mkdirSync(docsDir);
    mkdirSync(srcDir);
    writeFileSync(join(docsDir, "guide.md"), "# Guide");
    writeFileSync(join(srcDir, "main.ts"), "export function main() {}");

    const result = scanDirectory(tmpDir);
    if (result.sources.length >= 2) {
      assert.ok(result.sources[0].phase <= result.sources[1].phase);
    }
  });
});

// ─── Orchestrator tests ─────────────────────────────────────

describe("orchestrate", () => {
  let tmpDir;
  /** @type {import('../dist/ingest/orchestrator.js').orchestrate} */
  let orchestrate;

  // Minimal mock storage backend
  const mockDb = {
    findOrCreateEntity: async () => 1,
    storeFact: async () => 1,
    searchFacts: async () => [],
    graphTraverse: async () => null,
    listEntities: async () => [],
    deleteFact: async () => true,
    close: async () => {},
  };

  const mockEmbed = async () => new Float32Array(384);

  beforeEach(async () => {
    const mod = await import("../dist/ingest/orchestrator.js");
    orchestrate = mod.orchestrate;
    tmpDir = mkdtempSync(join(tmpdir(), "orch-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("completes with empty sources", async () => {
    /** @type {import('../dist/ingest/types.js').IngestState} */
    const state = {
      runId: "test-orch-1",
      status: "running",
      startedAt: new Date().toISOString(),
      scanRoot: tmpDir,
      sources: {},
      cancelRequested: false,
      factsStored: 0,
      duplicatesSkipped: 0,
      errors: [],
    };

    await orchestrate({
      scanResult: { root: tmpDir, sources: [] },
      db: mockDb,
      embed: mockEmbed,
      state,
    });

    assert.strictEqual(state.status, "done");
  });

  it("processes sources and fires progress events", async () => {
    const events = [];

    /** @type {import('../dist/ingest/types.js').IngestState} */
    const state = {
      runId: "test-orch-2",
      status: "running",
      startedAt: new Date().toISOString(),
      scanRoot: tmpDir,
      sources: {},
      cancelRequested: false,
      factsStored: 0,
      duplicatesSkipped: 0,
      errors: [],
    };

    // Create test files
    const srcDir = join(tmpDir, "src");
    mkdirSync(srcDir);
    writeFileSync(join(srcDir, "a.ts"), "export const a = 1;");
    writeFileSync(join(srcDir, "b.ts"), "export const b = 2;");

    await orchestrate({
      scanResult: {
        root: tmpDir,
        sources: [
          {
            name: "src",
            strategy: "code-analysis",
            phase: 2,
            files: [join(srcDir, "a.ts"), join(srcDir, "b.ts")],
          },
        ],
      },
      db: mockDb,
      embed: mockEmbed,
      state,
      onProgress: (event) => events.push(event),
    });

    assert.strictEqual(state.status, "done");
    assert.ok(events.length > 0, "Should have progress events");

    const startEvents = events.filter((e) => e.type === "source_start");
    assert.strictEqual(startEvents.length, 1);

    const doneEvents = events.filter((e) => e.type === "source_done");
    assert.strictEqual(doneEvents.length, 1);

    const ingestDoneEvents = events.filter((e) => e.type === "ingest_done");
    assert.strictEqual(ingestDoneEvents.length, 1);
  });

  it("respects cancel flag", async () => {
    /** @type {import('../dist/ingest/types.js').IngestState} */
    const state = {
      runId: "test-orch-3",
      status: "running",
      startedAt: new Date().toISOString(),
      scanRoot: tmpDir,
      sources: {},
      cancelRequested: true, // Pre-cancel
      factsStored: 0,
      duplicatesSkipped: 0,
      errors: [],
    };

    await orchestrate({
      scanResult: {
        root: tmpDir,
        sources: [
          { name: "src", strategy: "code-analysis", phase: 2, files: ["/fake/a.ts"] },
        ],
      },
      db: mockDb,
      embed: mockEmbed,
      state,
    });

    assert.strictEqual(state.status, "cancelled");
  });
});

// ─── Integration tests (skip without INTEGRATION=1) ────────

describe("integration: memory_ingest on test directory", { skip: !process.env.INTEGRATION }, () => {
  it("placeholder for MCP integration test", () => {
    // Full integration requires running MCP server with backends
    assert.ok(true);
  });
});

describe("integration: memory_ingest on empty dir", { skip: !process.env.INTEGRATION }, () => {
  it("placeholder for empty dir test", () => {
    assert.ok(true);
  });
});

describe("integration: memory_ingest_url", { skip: !process.env.INTEGRATION }, () => {
  it("placeholder for URL ingest integration test", () => {
    assert.ok(true);
  });
});

describe("integration: CLI ingest", { skip: !process.env.INTEGRATION }, () => {
  it("placeholder for CLI integration test", () => {
    assert.ok(true);
  });
});
