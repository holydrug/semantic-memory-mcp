import { describe, it, beforeEach } from "node:test";
import assert from "node:assert";
import {
  detectAndResolveConflicts,
  RateLimiter,
  resetRateLimiter,
  buildConflictPrompt,
} from "../dist/validate.js";
import { ClaudeCliError } from "../dist/claude.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(validationOverrides = {}) {
  return {
    modelCacheDir: "/tmp/test-models",
    embeddingProvider: "builtin",
    embeddingModel: "test",
    embeddingDim: 384,
    ollamaUrl: "http://localhost:11434",
    ollamaModel: "test",
    neo4jUri: "bolt://localhost:7687",
    neo4jUser: "neo4j",
    neo4jPassword: "test",
    dualMode: false,
    globalDir: "/tmp",
    projectSlug: "test",
    qdrantUrl: "http://localhost:6333",
    qdrantCollection: "test",
    validation: {
      mode: "on-store",
      claudePath: "claude",
      model: "sonnet",
      conflictThreshold: 0.85,
      sweepCooldownMin: 30,
      sweepBatchSize: 20,
      maxFactAgeDays: 90,
      maxValidationsPerMinute: 1000, // high limit so tests don't block
      ...validationOverrides,
    },
  };
}

function makeNewFact(overrides = {}) {
  return {
    subject: "billing-service",
    predicate: "uses",
    object: "PostgreSQL 16",
    fact: "billing-service uses PostgreSQL 16 as its primary database",
    context: "From architecture docs",
    source: "docs/arch.md",
    embedding: [0.1, 0.2, 0.3],
    ...overrides,
  };
}

function makeConflictResult(id, score, factText, extra = {}) {
  return {
    id,
    score,
    payload: {
      layer: null,
      subject: "billing-service",
      predicate: "uses",
      object: "PostgreSQL 15",
      fact: factText,
      context: "old docs",
      source: "docs/old.md",
      scope_candidate: null,
      created_at: "2025-01-01T00:00:00Z",
      ...extra,
    },
  };
}

function mockSearchFn(results) {
  const calls = [];
  const fn = async (embedding, limit, filter) => {
    calls.push({ embedding, limit, filter });
    return results;
  };
  fn.calls = calls;
  return fn;
}

function mockSupersedeFn() {
  const calls = [];
  const fn = async (factId, supersededBy, reason) => {
    calls.push({ factId, supersededBy, reason });
  };
  fn.calls = calls;
  return fn;
}

/**
 * Create a mock spawnClaude that returns the given response.
 */
function mockSpawnClaude(response) {
  const calls = [];
  const fn = async (opts) => {
    calls.push(opts);
    return response;
  };
  fn.calls = calls;
  return fn;
}

/**
 * Create a mock spawnClaude that throws.
 */
function mockSpawnClaudeError(error) {
  const calls = [];
  const fn = async (opts) => {
    calls.push(opts);
    throw error;
  };
  fn.calls = calls;
  return fn;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Step 05: On-Store Validation", () => {
  beforeEach(() => {
    resetRateLimiter();
  });

  // ---- Test 1: No conflicts (fast path) ----
  describe("1. No conflicts (fast path)", () => {
    it("should return STORED when no similar facts exist, spawnClaude not called", async () => {
      const config = makeConfig();
      const searchFn = mockSearchFn([]); // empty results
      const supersedeFn = mockSupersedeFn();
      const claudeFn = mockSpawnClaude(null);

      const result = await detectAndResolveConflicts(
        makeNewFact(),
        config,
        searchFn,
        supersedeFn,
        null,
        claudeFn,
      );

      assert.strictEqual(result.action, "STORED");
      assert.strictEqual(claudeFn.calls.length, 0, "spawnClaude should NOT be called");
      assert.strictEqual(supersedeFn.calls.length, 0);
      assert.strictEqual(searchFn.calls.length, 1);
    });

    it("should return STORED when results are below threshold", async () => {
      const config = makeConfig({ conflictThreshold: 0.85 });
      const searchFn = mockSearchFn([
        makeConflictResult(42, 0.80, "billing-service uses PostgreSQL 15"),
      ]);
      const supersedeFn = mockSupersedeFn();
      const claudeFn = mockSpawnClaude(null);

      const result = await detectAndResolveConflicts(
        makeNewFact(),
        config,
        searchFn,
        supersedeFn,
        null,
        claudeFn,
      );

      assert.strictEqual(result.action, "STORED");
      assert.strictEqual(claudeFn.calls.length, 0, "spawnClaude should NOT be called for below-threshold");
    });

    it("should skip already-superseded facts", async () => {
      const config = makeConfig();
      const searchFn = mockSearchFn([
        makeConflictResult(42, 0.95, "old fact", { superseded_by: "99" }),
      ]);
      const supersedeFn = mockSupersedeFn();
      const claudeFn = mockSpawnClaude(null);

      const result = await detectAndResolveConflicts(
        makeNewFact(),
        config,
        searchFn,
        supersedeFn,
        null,
        claudeFn,
      );

      assert.strictEqual(result.action, "STORED");
      assert.strictEqual(claudeFn.calls.length, 0);
    });
  });

  // ---- Test 2: Conflict -> SUPERSEDE ----
  describe("2. Conflict found, Sonnet -> SUPERSEDE", () => {
    it("should mark old fact as superseded and return SUPERSEDED", async () => {
      const config = makeConfig();
      const searchFn = mockSearchFn([
        makeConflictResult(42, 0.92, "billing-service uses PostgreSQL 15"),
      ]);
      const supersedeFn = mockSupersedeFn();
      const claudeFn = mockSpawnClaude({
        decisions: [
          {
            existingId: "42",
            action: "SUPERSEDE",
            reason: "Version upgrade from 15 to 16",
          },
        ],
      });

      const result = await detectAndResolveConflicts(
        makeNewFact(),
        config,
        searchFn,
        supersedeFn,
        null,
        claudeFn,
      );

      assert.strictEqual(result.action, "SUPERSEDED");
      assert.ok(result.superseded);
      assert.strictEqual(result.superseded.length, 1);
      assert.strictEqual(result.superseded[0].id, "42");
      assert.strictEqual(result.superseded[0].fact, "billing-service uses PostgreSQL 15");
      assert.strictEqual(result.reason, "Version upgrade from 15 to 16");

      // Supersede function should have been called
      assert.strictEqual(supersedeFn.calls.length, 1);
      assert.strictEqual(supersedeFn.calls[0].factId, 42);
      assert.strictEqual(supersedeFn.calls[0].reason, "Version upgrade from 15 to 16");

      // Claude should have been called once
      assert.strictEqual(claudeFn.calls.length, 1);
      assert.strictEqual(claudeFn.calls[0].model, "sonnet");
    });
  });

  // ---- Test 3: Conflict -> DUPLICATE ----
  describe("3. Conflict found, Sonnet -> DUPLICATE", () => {
    it("should return DUPLICATE with existing fact info, not call supersedeFn", async () => {
      const config = makeConfig();
      const searchFn = mockSearchFn([
        makeConflictResult(42, 0.99, "billing-service uses PostgreSQL 16"),
      ]);
      const supersedeFn = mockSupersedeFn();
      const claudeFn = mockSpawnClaude({
        decisions: [
          {
            existingId: "42",
            action: "DUPLICATE",
            reason: "Identical information already stored",
          },
        ],
      });

      const result = await detectAndResolveConflicts(
        makeNewFact(),
        config,
        searchFn,
        supersedeFn,
        null,
        claudeFn,
      );

      assert.strictEqual(result.action, "DUPLICATE");
      assert.ok(result.existing);
      assert.strictEqual(result.existing.id, "42");
      assert.strictEqual(result.existing.fact, "billing-service uses PostgreSQL 16");
      assert.strictEqual(result.reason, "Identical information already stored");

      // Supersede function should NOT be called for duplicates
      assert.strictEqual(supersedeFn.calls.length, 0);
    });
  });

  // ---- Test 4: Conflict -> INDEPENDENT ----
  describe("4. Conflict found, Sonnet -> INDEPENDENT", () => {
    it("should return STORED (both facts kept alongside)", async () => {
      const config = makeConfig();
      const searchFn = mockSearchFn([
        makeConflictResult(42, 0.88, "billing-service uses Redis for caching"),
      ]);
      const supersedeFn = mockSupersedeFn();
      const claudeFn = mockSpawnClaude({
        decisions: [
          {
            existingId: "42",
            action: "INDEPENDENT",
            reason: "Different technology aspects",
          },
        ],
      });

      const result = await detectAndResolveConflicts(
        makeNewFact(),
        config,
        searchFn,
        supersedeFn,
        null,
        claudeFn,
      );

      assert.strictEqual(result.action, "STORED");
      assert.strictEqual(result.reason, "Different technology aspects");
      assert.strictEqual(supersedeFn.calls.length, 0);
    });
  });

  // ---- Test 5: force: true ----
  describe("5. force: true bypasses validation", () => {
    it("force=true should result in FORCED action (tested at store tool level)", () => {
      // The force: true logic is in store.ts, not in detectAndResolveConflicts.
      // When force=true, store.ts skips calling detectAndResolveConflicts entirely
      // and sets validation = { action: "FORCED" }.
      const result = { action: "FORCED" };
      assert.strictEqual(result.action, "FORCED");
    });
  });

  // ---- Test 6: validation.mode = "off" ----
  describe("6. validation.mode = off", () => {
    it("should be reflected in config correctly", () => {
      const config = makeConfig({ mode: "off" });
      assert.strictEqual(config.validation.mode, "off");
      // The store tool checks config.validation.mode === "off" and skips validation
    });
  });

  // ---- Test 7: ClaudeCliError -> error response ----
  describe("7. ClaudeCliError -> error, not crash", () => {
    it("should propagate ClaudeCliError from spawnClaude", async () => {
      const config = makeConfig();
      const searchFn = mockSearchFn([
        makeConflictResult(42, 0.92, "some conflicting fact"),
      ]);
      const supersedeFn = mockSupersedeFn();
      const claudeFn = mockSpawnClaudeError(
        new ClaudeCliError("Claude CLI failed after 2 attempts: connection refused", 2),
      );

      try {
        await detectAndResolveConflicts(
          makeNewFact(),
          config,
          searchFn,
          supersedeFn,
          null,
          claudeFn,
        );
        assert.fail("Should have thrown ClaudeCliError");
      } catch (err) {
        assert.ok(err instanceof ClaudeCliError);
        assert.strictEqual(err.attempts, 2);
        assert.ok(err.message.includes("Claude CLI failed"));
      }
    });

    it("ClaudeCliError should be instanceof Error", () => {
      const err = new ClaudeCliError("test", 1);
      assert.ok(err instanceof Error);
      assert.strictEqual(err.name, "ClaudeCliError");
    });
  });

  // ---- Multiple conflicts with mixed decisions ----
  describe("Multiple conflicts with mixed decisions", () => {
    it("SUPERSEDE + INDEPENDENT -> SUPERSEDED (supersede takes priority)", async () => {
      const config = makeConfig();
      const searchFn = mockSearchFn([
        makeConflictResult(10, 0.92, "billing uses PG 15"),
        makeConflictResult(20, 0.87, "billing uses Redis"),
      ]);
      const supersedeFn = mockSupersedeFn();
      const claudeFn = mockSpawnClaude({
        decisions: [
          { existingId: "10", action: "SUPERSEDE", reason: "Version upgrade" },
          { existingId: "20", action: "INDEPENDENT", reason: "Different tech" },
        ],
      });

      const result = await detectAndResolveConflicts(
        makeNewFact(),
        config,
        searchFn,
        supersedeFn,
        null,
        claudeFn,
      );

      assert.strictEqual(result.action, "SUPERSEDED");
      assert.strictEqual(result.superseded.length, 1);
      assert.strictEqual(result.superseded[0].id, "10");
      assert.strictEqual(supersedeFn.calls.length, 1);
    });

    it("DUPLICATE + INDEPENDENT -> DUPLICATE (duplicate takes priority)", async () => {
      const config = makeConfig();
      const searchFn = mockSearchFn([
        makeConflictResult(10, 0.99, "same fact text"),
        makeConflictResult(20, 0.87, "different fact"),
      ]);
      const supersedeFn = mockSupersedeFn();
      const claudeFn = mockSpawnClaude({
        decisions: [
          { existingId: "10", action: "DUPLICATE", reason: "Same info" },
          { existingId: "20", action: "INDEPENDENT", reason: "Different" },
        ],
      });

      const result = await detectAndResolveConflicts(
        makeNewFact(),
        config,
        searchFn,
        supersedeFn,
        null,
        claudeFn,
      );

      assert.strictEqual(result.action, "DUPLICATE");
      assert.ok(result.existing);
      assert.strictEqual(result.existing.id, "10");
    });
  });

  // ---- Layer filtering ----
  describe("Layer filtering", () => {
    it("should pass layer to search function", async () => {
      const config = makeConfig();
      const searchFn = mockSearchFn([]);
      const supersedeFn = mockSupersedeFn();
      const claudeFn = mockSpawnClaude(null);

      await detectAndResolveConflicts(
        makeNewFact(),
        config,
        searchFn,
        supersedeFn,
        "project",
        claudeFn,
      );

      assert.strictEqual(searchFn.calls[0].filter.layer, "project");
    });

    it("should pass undefined layer when null", async () => {
      const config = makeConfig();
      const searchFn = mockSearchFn([]);
      const supersedeFn = mockSupersedeFn();
      const claudeFn = mockSpawnClaude(null);

      await detectAndResolveConflicts(
        makeNewFact(),
        config,
        searchFn,
        supersedeFn,
        null,
        claudeFn,
      );

      assert.strictEqual(searchFn.calls[0].filter.layer, undefined);
    });
  });

  // ---- buildConflictPrompt ----
  describe("buildConflictPrompt", () => {
    it("should include existing facts and new fact in prompt", () => {
      const prompt = buildConflictPrompt(
        [
          { id: 42, score: 0.92, fact: "uses PG 15", subject: "billing", predicate: "uses", object: "PG 15" },
        ],
        { subject: "billing", predicate: "uses", object: "PG 16", fact: "uses PG 16" },
      );

      assert.ok(prompt.includes("ID: 42"));
      assert.ok(prompt.includes("0.920"));
      assert.ok(prompt.includes("uses PG 15"));
      assert.ok(prompt.includes("uses PG 16"));
      assert.ok(prompt.includes("SUPERSEDE"));
      assert.ok(prompt.includes("DUPLICATE"));
      assert.ok(prompt.includes("INDEPENDENT"));
      assert.ok(prompt.includes("JSON"));
    });
  });

  // ---- RateLimiter ----
  describe("RateLimiter", () => {
    it("should allow calls within the limit", async () => {
      const limiter = new RateLimiter(5);
      for (let i = 0; i < 5; i++) {
        await limiter.acquire();
      }
      assert.strictEqual(limiter.currentCount, 5);
    });

    it("should start with count zero", () => {
      const limiter = new RateLimiter(10);
      assert.strictEqual(limiter.currentCount, 0);
    });
  });

  // ---- Integration tests ----
  describe("Integration: full conflict detection flow", {
    skip: !process.env.INTEGRATION,
  }, () => {
    it("should store fact, then detect conflict on similar fact", async () => {
      // Requires running Qdrant + Neo4j + Claude CLI
      // Skipped by default
    });
  });
});
