import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { mkdirSync, writeFileSync, rmSync, mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ── Imports from compiled output ──────────────────────────────────────────

import { computeFileHash, detectChanges, computeHashes } from "../dist/ingest/change-detect.js";
import { extractOpenApiFacts } from "../dist/ingest/strategies/api-contracts.js";
import { extractPackageJsonFacts, extractGoModFacts } from "../dist/ingest/strategies/dependency-graph.js";
import {
  getStrategy,
  orchestrate,
  InMemoryCheckpoint,
  acquireLock,
  releaseLock,
  isLockStale,
} from "../dist/ingest/orchestrator.js";

// ── Helpers ────────────────────────────────────────────────────────────────

function createTmpDir() {
  return mkdtempSync(join(tmpdir(), "sm-test-12-"));
}

function writeFile(dir, relPath, content = "x".repeat(100)) {
  const full = join(dir, relPath);
  const parent = join(full, "..");
  mkdirSync(parent, { recursive: true });
  writeFileSync(full, content, "utf-8");
  return full;
}

function makeConfig(overrides = {}) {
  return {
    modelCacheDir: "/tmp/models",
    embeddingProvider: "builtin",
    embeddingModel: "Xenova/all-MiniLM-L6-v2",
    embeddingDim: 384,
    ollamaUrl: "http://localhost:11434",
    ollamaModel: "nomic-embed-text",
    neo4jUri: "bolt://localhost:7687",
    neo4jUser: "neo4j",
    neo4jPassword: "test",
    dualMode: false,
    globalDir: "/tmp",
    projectSlug: "test",
    qdrantCollection: "test",
    validation: {
      mode: "off",
      claudePath: "claude",
      model: "sonnet",
      conflictThreshold: 0.85,
      sweepCooldownMin: 30,
      sweepBatchSize: 20,
      maxFactAgeDays: 90,
      maxValidationsPerMinute: 10,
    },
    ingest: {
      batchSize: 5,
      model: "sonnet",
    },
    ...overrides,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// Unit tests
// ═════════════════════════════════════════════════════════════════════════════

// ── computeFileHash ──────────────────────────────────────────────────────

describe("computeFileHash", () => {
  let tmpDir;

  before(() => {
    tmpDir = createTmpDir();
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("same content produces same hash", () => {
    const f1 = writeFile(tmpDir, "a.txt", "hello world");
    const f2 = writeFile(tmpDir, "b.txt", "hello world");
    assert.strictEqual(computeFileHash(f1), computeFileHash(f2));
  });

  it("different content produces different hash", () => {
    const f1 = writeFile(tmpDir, "c.txt", "hello");
    const f2 = writeFile(tmpDir, "d.txt", "world");
    assert.notStrictEqual(computeFileHash(f1), computeFileHash(f2));
  });

  it("hash starts with sha256:", () => {
    const f = writeFile(tmpDir, "e.txt", "test");
    const hash = computeFileHash(f);
    assert.ok(hash.startsWith("sha256:"), `Expected sha256: prefix, got ${hash}`);
  });

  it("hash is deterministic across calls", () => {
    const f = writeFile(tmpDir, "f.txt", "deterministic");
    const h1 = computeFileHash(f);
    const h2 = computeFileHash(f);
    assert.strictEqual(h1, h2);
  });
});

// ── detectChanges ──────────────────────────────────────────────────────────

describe("detectChanges", () => {
  it("detects changed files", () => {
    const current = new Map([
      ["a.txt", "sha256:aaa"],
      ["b.txt", "sha256:bbb_new"],
    ]);
    const stored = new Map([
      ["a.txt", "sha256:aaa"],
      ["b.txt", "sha256:bbb_old"],
    ]);

    const result = detectChanges(current, stored);
    assert.deepStrictEqual(result.changed, ["b.txt"]);
    assert.deepStrictEqual(result.added, []);
    assert.deepStrictEqual(result.deleted, []);
    assert.deepStrictEqual(result.unchanged, ["a.txt"]);
  });

  it("detects added files", () => {
    const current = new Map([
      ["a.txt", "sha256:aaa"],
      ["c.txt", "sha256:ccc"],
    ]);
    const stored = new Map([
      ["a.txt", "sha256:aaa"],
    ]);

    const result = detectChanges(current, stored);
    assert.deepStrictEqual(result.added, ["c.txt"]);
    assert.deepStrictEqual(result.unchanged, ["a.txt"]);
    assert.deepStrictEqual(result.deleted, []);
  });

  it("detects deleted files", () => {
    const current = new Map([
      ["a.txt", "sha256:aaa"],
    ]);
    const stored = new Map([
      ["a.txt", "sha256:aaa"],
      ["b.txt", "sha256:bbb"],
    ]);

    const result = detectChanges(current, stored);
    assert.deepStrictEqual(result.deleted, ["b.txt"]);
    assert.deepStrictEqual(result.unchanged, ["a.txt"]);
    assert.deepStrictEqual(result.changed, []);
    assert.deepStrictEqual(result.added, []);
  });

  it("handles empty stored (all new)", () => {
    const current = new Map([
      ["a.txt", "sha256:aaa"],
      ["b.txt", "sha256:bbb"],
    ]);
    const stored = new Map();

    const result = detectChanges(current, stored);
    assert.strictEqual(result.added.length, 2);
    assert.strictEqual(result.unchanged.length, 0);
    assert.strictEqual(result.deleted.length, 0);
    assert.strictEqual(result.changed.length, 0);
  });

  it("handles empty current (all deleted)", () => {
    const current = new Map();
    const stored = new Map([
      ["a.txt", "sha256:aaa"],
    ]);

    const result = detectChanges(current, stored);
    assert.deepStrictEqual(result.deleted, ["a.txt"]);
    assert.strictEqual(result.added.length, 0);
    assert.strictEqual(result.changed.length, 0);
  });

  it("handles mixed changes", () => {
    const current = new Map([
      ["a.txt", "sha256:aaa"],         // unchanged
      ["b.txt", "sha256:bbb_new"],     // changed
      ["d.txt", "sha256:ddd"],         // added
    ]);
    const stored = new Map([
      ["a.txt", "sha256:aaa"],
      ["b.txt", "sha256:bbb_old"],
      ["c.txt", "sha256:ccc"],         // deleted
    ]);

    const result = detectChanges(current, stored);
    assert.deepStrictEqual(result.unchanged, ["a.txt"]);
    assert.deepStrictEqual(result.changed, ["b.txt"]);
    assert.deepStrictEqual(result.added, ["d.txt"]);
    assert.deepStrictEqual(result.deleted, ["c.txt"]);
  });
});

// ── computeHashes ────────────────────────────────────────────────────────

describe("computeHashes", () => {
  let tmpDir;

  before(() => {
    tmpDir = createTmpDir();
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("computes hashes for a list of files", () => {
    const f1 = writeFile(tmpDir, "x.txt", "hello");
    const f2 = writeFile(tmpDir, "y.txt", "world");
    const hashes = computeHashes([f1, f2]);
    assert.strictEqual(hashes.size, 2);
    assert.ok(hashes.get(f1)?.startsWith("sha256:"));
    assert.ok(hashes.get(f2)?.startsWith("sha256:"));
  });

  it("skips unreadable files silently", () => {
    const hashes = computeHashes(["/nonexistent/file.txt"]);
    assert.strictEqual(hashes.size, 0);
  });
});

// ── OpenAPI extraction ───────────────────────────────────────────────────

describe("extractOpenApiFacts", () => {
  it("extracts endpoints from a simple OpenAPI JSON spec", () => {
    const spec = JSON.stringify({
      openapi: "3.0.0",
      info: { title: "Pet Store", version: "1.0.0" },
      paths: {
        "/pets": {
          get: {
            summary: "List all pets",
            operationId: "listPets",
            tags: ["pets"],
            responses: {
              "200": {
                description: "A list of pets",
                content: {
                  "application/json": {
                    schema: { $ref: "#/components/schemas/Pets" },
                  },
                },
              },
            },
          },
          post: {
            summary: "Create a pet",
            operationId: "createPet",
            requestBody: {
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/Pet" },
                },
              },
            },
            responses: {
              "201": { description: "Created" },
              "409": { description: "Pet already exists" },
            },
          },
        },
      },
      components: {
        schemas: {
          Pet: {
            properties: { id: { type: "integer" }, name: { type: "string" } },
            required: ["id", "name"],
          },
          Pets: {
            properties: { items: { type: "array" } },
          },
        },
      },
    });

    const facts = extractOpenApiFacts("api.json", spec);

    // Should have endpoint facts
    const endpoints = facts.filter((f) => f.predicate === "has_endpoint");
    assert.ok(endpoints.length >= 2, `Expected at least 2 endpoints, got ${endpoints.length}`);

    const getEndpoint = endpoints.find((f) => f.object === "GET /pets");
    assert.ok(getEndpoint, "Should have GET /pets endpoint");
    assert.strictEqual(getEndpoint.subject, "Pet Store");
    assert.strictEqual(getEndpoint.version, "1.0.0");

    const postEndpoint = endpoints.find((f) => f.object === "POST /pets");
    assert.ok(postEndpoint, "Should have POST /pets endpoint");

    // Should have request body
    const requestFacts = facts.filter((f) => f.predicate === "accepts");
    assert.ok(requestFacts.length >= 1, "Should have request body fact");

    // Should have response
    const responseFacts = facts.filter((f) => f.predicate === "returns");
    assert.ok(responseFacts.length >= 1, "Should have response fact");

    // Should have error
    const errorFacts = facts.filter((f) => f.predicate === "error");
    assert.ok(errorFacts.length >= 1, "Should have error fact");

    // Should have schema definitions
    const schemaFacts = facts.filter((f) => f.predicate === "defines_schema");
    assert.ok(schemaFacts.length >= 1, "Should have schema definitions");
    const petSchema = schemaFacts.find((f) => f.object === "Pet");
    assert.ok(petSchema, "Should have Pet schema");
    assert.ok(petSchema.fact.includes("id"), "Pet schema should mention id field");
    assert.ok(petSchema.fact.includes("name"), "Pet schema should mention name field");
  });

  it("extracts endpoints from simple OpenAPI YAML-like content parsed as JSON", () => {
    // Since our YAML parser is simple, test with JSON but verify output
    const spec = JSON.stringify({
      openapi: "3.0.0",
      info: { title: "IAM API", version: "1.18.0" },
      paths: {
        "/v1/roles": {
          post: {
            summary: "Create a role",
            security: [{ BearerAuth: [] }],
            responses: {
              "200": { description: "Role created" },
            },
          },
        },
      },
      components: {
        securitySchemes: {
          BearerAuth: { type: "http", scheme: "bearer" },
        },
      },
    });

    const facts = extractOpenApiFacts("iam-api.json", spec);

    // Check auth requirement
    const authFacts = facts.filter((f) => f.predicate === "requires_auth");
    assert.ok(authFacts.length >= 1, "Should detect auth requirements");

    // Check security scheme
    const schemeFacts = facts.filter((f) => f.predicate === "has_auth_scheme");
    assert.ok(schemeFacts.length >= 1, "Should extract security schemes");
    assert.ok(schemeFacts[0].fact.includes("bearer"), "Should mention bearer");
  });

  it("returns empty array for invalid content", () => {
    const facts = extractOpenApiFacts("bad.json", "not valid json or yaml");
    assert.deepStrictEqual(facts, []);
  });

  it("handles spec with no paths", () => {
    const spec = JSON.stringify({
      openapi: "3.0.0",
      info: { title: "Empty API", version: "0.1.0" },
    });
    const facts = extractOpenApiFacts("empty.json", spec);
    assert.ok(Array.isArray(facts));
    // May have 0 facts or just metadata
  });
});

// ── Package.json extraction ──────────────────────────────────────────────

describe("extractPackageJsonFacts", () => {
  it("extracts dependencies from package.json", () => {
    const content = JSON.stringify({
      name: "my-service",
      version: "2.0.0",
      dependencies: {
        express: "^4.18.0",
        pg: "^8.11.0",
      },
      devDependencies: {
        typescript: "^5.0.0",
      },
      engines: {
        node: ">=18",
      },
    });

    const facts = extractPackageJsonFacts("/project/package.json", content);

    // Should have dependency facts
    const deps = facts.filter((f) => f.predicate === "depends_on");
    assert.strictEqual(deps.length, 2);
    assert.ok(deps.some((f) => f.object.includes("express")));
    assert.ok(deps.some((f) => f.object.includes("pg")));

    // Should have dev dependency
    const devDeps = facts.filter((f) => f.predicate === "dev_depends_on");
    assert.strictEqual(devDeps.length, 1);
    assert.ok(devDeps[0].object.includes("typescript"));

    // Should have engine requirement
    const engines = facts.filter((f) => f.predicate === "requires_engine");
    assert.strictEqual(engines.length, 1);
    assert.ok(engines[0].object.includes("node"));

    // Subject should be the package name
    assert.strictEqual(deps[0].subject, "my-service");
  });

  it("handles package.json with no dependencies", () => {
    const content = JSON.stringify({ name: "minimal", version: "1.0.0" });
    const facts = extractPackageJsonFacts("/project/package.json", content);
    assert.deepStrictEqual(facts, []);
  });

  it("returns empty for invalid JSON", () => {
    const facts = extractPackageJsonFacts("/project/package.json", "invalid json");
    assert.deepStrictEqual(facts, []);
  });
});

// ── Go.mod extraction ────────────────────────────────────────────────────

describe("extractGoModFacts", () => {
  it("extracts dependencies from go.mod", () => {
    const content = `module github.com/example/my-service

go 1.21

require (
\tgithub.com/gin-gonic/gin v1.9.1
\tgithub.com/lib/pq v1.10.9
\tgolang.org/x/sync v0.5.0 // indirect
)
`;

    const facts = extractGoModFacts("/project/go.mod", content);

    // Should have go version
    const engineFacts = facts.filter((f) => f.predicate === "requires_engine");
    assert.strictEqual(engineFacts.length, 1);
    assert.ok(engineFacts[0].object.includes("1.21"));

    // Should have direct dependencies
    const directDeps = facts.filter((f) => f.predicate === "depends_on");
    assert.ok(directDeps.length >= 2);
    assert.ok(directDeps.some((f) => f.object.includes("gin")));
    assert.ok(directDeps.some((f) => f.object.includes("pq")));

    // Should have indirect dependency
    const indirectDeps = facts.filter((f) => f.predicate === "indirect_depends_on");
    assert.ok(indirectDeps.length >= 1);
    assert.ok(indirectDeps[0].object.includes("sync"));

    // Subject should be the module name
    assert.strictEqual(directDeps[0].subject, "github.com/example/my-service");
  });

  it("handles go.mod with single-line require", () => {
    const content = `module example.com/simple

go 1.20

require github.com/pkg/errors v0.9.1
`;
    const facts = extractGoModFacts("/project/go.mod", content);
    const deps = facts.filter((f) => f.predicate === "depends_on");
    assert.strictEqual(deps.length, 1);
    assert.ok(deps[0].object.includes("errors"));
  });
});

// ── getStrategy ──────────────────────────────────────────────────────────

describe("getStrategy", () => {
  it("returns documentation strategy", () => {
    const s = getStrategy("documentation");
    assert.strictEqual(s.name, "documentation");
  });

  it("returns code-analysis strategy", () => {
    const s = getStrategy("code-analysis");
    assert.strictEqual(s.name, "code-analysis");
  });

  it("returns pdf strategy", () => {
    const s = getStrategy("pdf");
    assert.strictEqual(s.name, "pdf");
  });

  it("returns api-contracts strategy", () => {
    const s = getStrategy("api-contracts");
    assert.strictEqual(s.name, "api-contracts");
  });

  it("returns dependency-graph strategy", () => {
    const s = getStrategy("dependency-graph");
    assert.strictEqual(s.name, "dependency-graph");
  });

  it("returns changelog strategy", () => {
    const s = getStrategy("changelog");
    assert.strictEqual(s.name, "changelog");
  });

  it("throws for unknown strategy", () => {
    assert.throws(() => getStrategy("unknown"), /Unknown extraction strategy/);
  });
});

// ── InMemoryCheckpoint ──────────────────────────────────────────────────

describe("InMemoryCheckpoint", () => {
  it("stores and retrieves state", async () => {
    const cp = new InMemoryCheckpoint();
    assert.strictEqual(await cp.loadState(), null);

    const state = {
      runId: "test-1",
      startedAt: "2026-03-17T00:00:00Z",
      scanRoot: "/tmp",
      sources: {},
    };
    await cp.saveState(state);

    const loaded = await cp.loadState();
    assert.deepStrictEqual(loaded, state);

    await cp.clearState();
    assert.strictEqual(await cp.loadState(), null);
  });

  it("stores and retrieves lock", async () => {
    const cp = new InMemoryCheckpoint();
    assert.strictEqual(await cp.loadLock(), null);

    const lock = { runId: "test-1", pid: 12345, startedAt: "2026-03-17T00:00:00Z" };
    await cp.saveLock(lock);

    const loaded = await cp.loadLock();
    assert.deepStrictEqual(loaded, lock);

    await cp.clearLock();
    assert.strictEqual(await cp.loadLock(), null);
  });

  it("stores and retrieves hashes", async () => {
    const cp = new InMemoryCheckpoint();
    const hashes = new Map([["a.txt", "sha256:abc"]]);

    assert.strictEqual((await cp.loadHashes("src")).size, 0);

    await cp.saveHashes("src", hashes);
    const loaded = await cp.loadHashes("src");
    assert.strictEqual(loaded.size, 1);
    assert.strictEqual(loaded.get("a.txt"), "sha256:abc");
  });
});

// ── Ingestion lock ──────────────────────────────────────────────────────

describe("Ingestion lock", () => {
  it("acquires lock when none exists", async () => {
    const cp = new InMemoryCheckpoint();
    const acquired = await acquireLock("run-1", cp);
    assert.strictEqual(acquired, true);

    const lock = await cp.loadLock();
    assert.strictEqual(lock.runId, "run-1");
    assert.strictEqual(lock.pid, process.pid);
  });

  it("rejects lock when held by live process", async () => {
    const cp = new InMemoryCheckpoint();
    // Simulate a lock held by current process (which is alive)
    await cp.saveLock({ runId: "run-0", pid: process.pid, startedAt: "2026-03-17T00:00:00Z" });

    const acquired = await acquireLock("run-1", cp);
    assert.strictEqual(acquired, false);
  });

  it("steals lock when held by dead process", async () => {
    const cp = new InMemoryCheckpoint();
    // Simulate a lock held by a non-existent PID
    await cp.saveLock({ runId: "run-old", pid: 999999, startedAt: "2026-03-17T00:00:00Z" });

    const acquired = await acquireLock("run-new", cp);
    assert.strictEqual(acquired, true);

    const lock = await cp.loadLock();
    assert.strictEqual(lock.runId, "run-new");
  });

  it("releases lock correctly", async () => {
    const cp = new InMemoryCheckpoint();
    await acquireLock("run-1", cp);
    await releaseLock("run-1", cp);
    assert.strictEqual(await cp.loadLock(), null);
  });

  it("does not release lock with wrong runId", async () => {
    const cp = new InMemoryCheckpoint();
    await acquireLock("run-1", cp);
    await releaseLock("run-wrong", cp);
    const lock = await cp.loadLock();
    assert.strictEqual(lock.runId, "run-1");
  });

  it("isLockStale returns true for dead PID", () => {
    assert.strictEqual(
      isLockStale({ runId: "x", pid: 999999, startedAt: "2026-01-01T00:00:00Z" }),
      true,
    );
  });

  it("isLockStale returns false for live PID", () => {
    assert.strictEqual(
      isLockStale({ runId: "x", pid: process.pid, startedAt: "2026-01-01T00:00:00Z" }),
      false,
    );
  });
});

// ── Orchestrator ────────────────────────────────────────────────────────

describe("orchestrate", () => {
  it("processes sources in phase order", async () => {
    const cp = new InMemoryCheckpoint();
    const config = makeConfig();
    const storedFacts = [];

    // Mock storeFn that always succeeds
    const storeFn = async (fact) => {
      storedFacts.push(fact);
      return true;
    };

    // Create temp files for sources
    const tmpDir = createTmpDir();
    try {
      const f1 = writeFile(tmpDir, "pkg1/package.json", JSON.stringify({
        name: "test-pkg",
        version: "1.0.0",
        dependencies: { express: "^4.0.0" },
      }));
      const f2 = writeFile(tmpDir, "pkg2/package.json", JSON.stringify({
        name: "another-pkg",
        dependencies: { lodash: "^4.0.0" },
      }));

      const sources = [
        {
          name: "phase3-service",
          path: tmpDir,
          strategy: "dependency-graph",
          phase: 3,
          scope: "project",
          files: [f2],
        },
        {
          name: "phase1-deps",
          path: tmpDir,
          strategy: "dependency-graph",
          phase: 1,
          scope: "global",
          files: [f1],
        },
      ];

      const events = [];
      for await (const event of orchestrate(sources, config, storeFn, cp, tmpDir)) {
        events.push(event);
      }

      // Should have source_start events in phase order
      const starts = events.filter((e) => e.type === "source_start");
      assert.strictEqual(starts.length, 2);
      assert.strictEqual(starts[0].source, "phase1-deps"); // phase 1 first
      assert.strictEqual(starts[1].source, "phase3-service"); // phase 3 second

      // Should have done events
      const dones = events.filter((e) => e.type === "source_done");
      assert.strictEqual(dones.length, 2);

      // Should have final done event
      const finalDone = events.find((e) => e.type === "done");
      assert.ok(finalDone, "Should have final done event");

      // Should have stored facts
      assert.ok(storedFacts.length > 0, `Expected stored facts, got ${storedFacts.length}`);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("continues after source error", async () => {
    const cp = new InMemoryCheckpoint();
    const config = makeConfig();
    const storedFacts = [];

    const storeFn = async (fact) => {
      storedFacts.push(fact);
      return true;
    };

    const tmpDir = createTmpDir();
    try {
      const goodFile = writeFile(tmpDir, "good-pkg/package.json", JSON.stringify({
        name: "good-pkg",
        dependencies: { express: "^4.0.0" },
      }));

      const sources = [
        {
          name: "bad-source",
          path: tmpDir,
          strategy: "dependency-graph",
          phase: 1,
          scope: "global",
          files: ["/nonexistent/file.that.does.not.exist"],
        },
        {
          name: "good-source",
          path: tmpDir,
          strategy: "dependency-graph",
          phase: 2,
          scope: "project",
          files: [goodFile],
        },
      ];

      const events = [];
      for await (const event of orchestrate(sources, config, storeFn, cp, tmpDir)) {
        events.push(event);
      }

      // Bad source should have error or done (files simply won't hash)
      // Good source should succeed
      const goodDone = events.find((e) => e.type === "source_done" && e.source === "good-source");
      assert.ok(goodDone, "Good source should complete");

      // Final done event should be present
      const finalDone = events.find((e) => e.type === "done");
      assert.ok(finalDone, "Should have final done event");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("skips unchanged files on re-run (change detection)", async () => {
    const cp = new InMemoryCheckpoint();
    const config = makeConfig();
    let storeCalls = 0;

    const storeFn = async (_fact) => {
      storeCalls++;
      return true;
    };

    const tmpDir = createTmpDir();
    try {
      const f = writeFile(tmpDir, "ct/package.json", JSON.stringify({
        name: "change-test",
        dependencies: { express: "^4.0.0" },
      }));

      const sources = [
        {
          name: "test-source",
          path: tmpDir,
          strategy: "dependency-graph",
          phase: 1,
          scope: "global",
          files: [f],
        },
      ];

      // First run
      for await (const _event of orchestrate(sources, config, storeFn, cp, tmpDir)) {
        // consume events
      }
      const firstRunCalls = storeCalls;
      assert.ok(firstRunCalls > 0, "First run should store facts");

      // Second run with same files (no changes)
      storeCalls = 0;
      for await (const _event of orchestrate(sources, config, storeFn, cp, tmpDir)) {
        // consume events
      }
      assert.strictEqual(storeCalls, 0, "Second run should skip unchanged files");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("re-processes changed files", async () => {
    const cp = new InMemoryCheckpoint();
    const config = makeConfig();
    let storeCalls = 0;

    const storeFn = async (_fact) => {
      storeCalls++;
      return true;
    };

    const tmpDir = createTmpDir();
    try {
      const f = writeFile(tmpDir, "rc/package.json", JSON.stringify({
        name: "change-test",
        dependencies: { express: "^4.0.0" },
      }));

      const sources = [
        {
          name: "test-source",
          path: tmpDir,
          strategy: "dependency-graph",
          phase: 1,
          scope: "global",
          files: [f],
        },
      ];

      // First run
      for await (const _event of orchestrate(sources, config, storeFn, cp, tmpDir)) {
        // consume events
      }
      const firstRunCalls = storeCalls;
      assert.ok(firstRunCalls > 0, "First run should store facts");

      // Modify file
      writeFile(tmpDir, "rc/package.json", JSON.stringify({
        name: "change-test",
        dependencies: { express: "^5.0.0", lodash: "^4.0.0" },
      }));

      // Second run with changed file
      storeCalls = 0;
      for await (const _event of orchestrate(sources, config, storeFn, cp, tmpDir)) {
        // consume events
      }
      assert.ok(storeCalls > 0, "Second run should re-process changed file");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("rejects concurrent ingestion", async () => {
    const cp = new InMemoryCheckpoint();
    const config = makeConfig();
    const storeFn = async () => true;

    // Simulate a lock held by current process
    await cp.saveLock({ runId: "existing", pid: process.pid, startedAt: new Date().toISOString() });

    const events = [];
    for await (const event of orchestrate([], config, storeFn, cp)) {
      events.push(event);
    }

    // Should get an error about already running
    const error = events.find((e) => e.type === "source_error");
    assert.ok(error, "Should get error event");
    assert.ok(error.error.includes("already running"), `Error should mention already running: ${error.error}`);
  });

  it("resumes from checkpoint (skips done sources)", async () => {
    const cp = new InMemoryCheckpoint();
    const config = makeConfig();
    let storeCalls = 0;
    const storeFn = async (_fact) => {
      storeCalls++;
      return true;
    };

    const tmpDir = createTmpDir();
    try {
      const f1 = writeFile(tmpDir, "done-dir/package.json", JSON.stringify({
        name: "done-pkg",
        dependencies: { express: "^4.0.0" },
      }));
      const f2 = writeFile(tmpDir, "pending-dir/package.json", JSON.stringify({
        name: "pending-pkg",
        dependencies: { lodash: "^4.0.0" },
      }));

      // Pre-seed checkpoint with one source already done
      const preState = {
        runId: "old-run",
        startedAt: "2026-03-17T00:00:00Z",
        scanRoot: tmpDir,
        sources: {
          "done-source": {
            status: "done",
            phase: 1,
            strategy: "dependency-graph",
            filesTotal: 1,
            filesProcessed: 1,
            factsStored: 1,
            duplicatesSkipped: 0,
            completedAt: "2026-03-17T00:01:00Z",
          },
          "pending-source": {
            status: "pending",
            phase: 2,
            strategy: "dependency-graph",
            filesTotal: 1,
            filesProcessed: 0,
            factsStored: 0,
            duplicatesSkipped: 0,
          },
        },
      };
      await cp.saveState(preState);

      const sources = [
        {
          name: "done-source",
          path: tmpDir,
          strategy: "dependency-graph",
          phase: 1,
          scope: "global",
          files: [f1],
        },
        {
          name: "pending-source",
          path: tmpDir,
          strategy: "dependency-graph",
          phase: 2,
          scope: "project",
          files: [f2],
        },
      ];

      const events = [];
      for await (const event of orchestrate(sources, config, storeFn, cp, tmpDir)) {
        events.push(event);
      }

      // done-source should NOT have a source_start event (skipped)
      const doneStarts = events.filter((e) => e.type === "source_start" && e.source === "done-source");
      assert.strictEqual(doneStarts.length, 0, "Done source should be skipped");

      // pending-source should have started
      const pendingStarts = events.filter((e) => e.type === "source_start" && e.source === "pending-source");
      assert.strictEqual(pendingStarts.length, 1, "Pending source should start");

      // Should have final done event
      const finalDone = events.find((e) => e.type === "done");
      assert.ok(finalDone, "Should have final done event");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("handles storeFn returning false (duplicate)", async () => {
    const cp = new InMemoryCheckpoint();
    const config = makeConfig();

    // storeFn that always says "duplicate"
    const storeFn = async (_fact) => false;

    const tmpDir = createTmpDir();
    try {
      const f = writeFile(tmpDir, "dup/package.json", JSON.stringify({
        name: "dup-test",
        dependencies: { express: "^4.0.0" },
      }));

      const sources = [
        {
          name: "test",
          path: tmpDir,
          strategy: "dependency-graph",
          phase: 1,
          scope: "global",
          files: [f],
        },
      ];

      const events = [];
      for await (const event of orchestrate(sources, config, storeFn, cp, tmpDir)) {
        events.push(event);
      }

      // Should complete without errors
      const doneEvent = events.find((e) => e.type === "source_done" && e.source === "test");
      assert.ok(doneEvent, "Should complete source");
      assert.strictEqual(doneEvent.factsStored, 0, "No facts stored (all duplicates)");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Integration tests (require Claude CLI)
// ═════════════════════════════════════════════════════════════════════════════

describe("documentation strategy (integration)", { skip: !process.env.INTEGRATION }, () => {
  let tmpDir;

  before(() => {
    tmpDir = createTmpDir();
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("extracts facts from markdown files", async () => {
    writeFile(tmpDir, "api-guide.md", `# Auth API Guide

## Authentication
All requests require a Bearer token in the Authorization header.
The token is obtained via the /auth/login endpoint.

## Endpoints
- POST /auth/login - Authenticate user, returns JWT token
- POST /auth/refresh - Refresh expired token
- GET /auth/me - Get current user info

## Rate Limiting
All endpoints are rate-limited to 100 requests per minute per IP.
`);

    writeFile(tmpDir, "config-guide.md", `# Configuration

## Database
- DB_HOST: PostgreSQL host (default: localhost)
- DB_PORT: PostgreSQL port (default: 5432)
- DB_NAME: Database name (required)

## Cache
Redis is used for session storage. Configure via REDIS_URL env var.
`);

    const strategy = getStrategy("documentation");
    const config = makeConfig();
    const facts = await strategy.extract(
      [join(tmpDir, "api-guide.md"), join(tmpDir, "config-guide.md")],
      "Auth service documentation",
      config,
    );

    assert.ok(Array.isArray(facts), "Should return array");
    assert.ok(facts.length > 0, `Should extract facts, got ${facts.length}`);

    // Each fact should have required fields
    for (const fact of facts) {
      assert.ok(fact.subject, "Fact should have subject");
      assert.ok(fact.predicate, "Fact should have predicate");
      assert.ok(fact.object, "Fact should have object");
      assert.ok(fact.fact, "Fact should have fact description");
    }
  });
});

describe("code-analysis strategy (integration)", { skip: !process.env.INTEGRATION }, () => {
  let tmpDir;

  before(() => {
    tmpDir = createTmpDir();
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("extracts facts from TypeScript files", async () => {
    writeFile(tmpDir, "UserService.ts", `
import { Injectable } from '@nestjs/common';
import { UserRepository } from './UserRepository';

@Injectable()
export class UserService {
  constructor(private readonly userRepo: UserRepository) {}

  async findById(id: string): Promise<User | null> {
    return this.userRepo.findById(id);
  }

  async createUser(dto: CreateUserDto): Promise<User> {
    const existing = await this.userRepo.findByEmail(dto.email);
    if (existing) throw new ConflictException('Email already in use');
    return this.userRepo.create(dto);
  }
}
`);

    writeFile(tmpDir, "AuthController.ts", `
import { Controller, Post, Body } from '@nestjs/common';
import { AuthService } from './AuthService';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('login')
  async login(@Body() dto: LoginDto): Promise<TokenResponse> {
    return this.authService.login(dto.email, dto.password);
  }
}
`);

    const strategy = getStrategy("code-analysis");
    const config = makeConfig();
    const facts = await strategy.extract(
      [join(tmpDir, "UserService.ts"), join(tmpDir, "AuthController.ts")],
      "NestJS auth service",
      config,
    );

    assert.ok(Array.isArray(facts), "Should return array");
    assert.ok(facts.length > 0, `Should extract facts, got ${facts.length}`);
  });
});

describe("orchestrator full run (integration)", { skip: !process.env.INTEGRATION }, () => {
  it("runs orchestrator with real sources and facts are stored", async () => {
    const cp = new InMemoryCheckpoint();
    const config = makeConfig();
    const storedFacts = [];
    const storeFn = async (fact) => {
      storedFacts.push(fact);
      return true;
    };

    const tmpDir = createTmpDir();
    try {
      writeFile(tmpDir, "package.json", JSON.stringify({
        name: "integration-test",
        version: "1.0.0",
        dependencies: { express: "^4.18.0", pg: "^8.11.0" },
      }));

      writeFile(tmpDir, "docs/README.md", `# My Service

This service handles user authentication. It uses JWT tokens and connects to PostgreSQL.
It exposes REST endpoints under /api/v1/.
` + "x".repeat(100));

      const sources = [
        {
          name: "deps",
          path: tmpDir,
          strategy: "dependency-graph",
          phase: 4,
          scope: "global",
          files: [join(tmpDir, "package.json")],
        },
      ];

      const events = [];
      for await (const event of orchestrate(sources, config, storeFn, cp, tmpDir)) {
        events.push(event);
      }

      assert.ok(storedFacts.length > 0, `Should store facts, got ${storedFacts.length}`);
      assert.ok(events.some((e) => e.type === "done"), "Should complete");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
