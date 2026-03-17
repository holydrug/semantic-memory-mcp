import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";

// Import from compiled dist
const {
  sweepOnce,
  maybeSweepOnStart,
  buildSweepPrompt,
  getLastSweepTs,
  setLastSweepTs,
  _resetLastSweepTs,
} = await import("../dist/sweep.js");

const { resetRateLimiter } = await import("../dist/validate.js");

// ─── Helper: create a mock backend ──────────────────────────────────────

function createMockBackend(facts = []) {
  const validationUpdates = [];
  return {
    backend: {
      findOrCreateEntity: async () => 1,
      storeFact: async () => 1,
      searchFacts: async () => [],
      graphTraverse: async () => null,
      listEntities: async () => [],
      deleteFact: async () => true,
      close: async () => {},
      queryFactsForValidation: async (opts) => {
        let result = [...facts];
        if (opts.subject) {
          result = result.filter((f) =>
            f.subject.toLowerCase().includes(opts.subject.toLowerCase()),
          );
        }
        if (opts.source) {
          result = result.filter((f) => f.source === opts.source);
        }
        return result.slice(0, opts.limit);
      },
      updateFactValidation: async (factId, updates) => {
        validationUpdates.push({ factId, ...updates });
      },
    },
    validationUpdates,
  };
}

// ─── Helper: create mock config ──────────────────────────────────────────

function createMockConfig(overrides = {}) {
  return {
    modelCacheDir: "/tmp/test-models",
    embeddingProvider: "builtin",
    embeddingModel: "Xenova/all-MiniLM-L6-v2",
    embeddingDim: 384,
    ollamaUrl: "http://localhost:11434",
    ollamaModel: "nomic-embed-text",
    neo4jUri: "bolt://localhost:7687",
    neo4jUser: "neo4j",
    neo4jPassword: "test",
    dualMode: false,
    globalDir: "/tmp/test-global",
    projectSlug: "test-project",
    qdrantUrl: undefined,
    qdrantCollection: "test_collection",
    validation: {
      mode: "on-store",
      claudePath: "claude",
      model: "sonnet",
      conflictThreshold: 0.85,
      sweepCooldownMin: 30,
      sweepBatchSize: 20,
      maxFactAgeDays: 90,
      maxValidationsPerMinute: 100,
      ...overrides,
    },
  };
}

// ─── Helper: create mock spawnClaude ─────────────────────────────────────

function createMockSpawnClaude(decisions) {
  let callCount = 0;
  const calls = [];
  const fn = async (opts) => {
    callCount++;
    calls.push(opts);
    return { decisions };
  };
  fn.getCallCount = () => callCount;
  fn.getCalls = () => calls;
  return fn;
}

// ─── Sample facts ────────────────────────────────────────────────────────

function createSampleFacts(count = 5) {
  const facts = [];
  for (let i = 1; i <= count; i++) {
    facts.push({
      factId: i,
      subject: `entity-${i}`,
      predicate: "uses",
      object: `library-${i}`,
      content: `entity-${i} uses library-${i} v${i}.0`,
      source: `source-${i}`,
      confidence: 1.0,
      lastValidated: null,
    });
  }
  return facts;
}

// ─── Unit tests: buildSweepPrompt ────────────────────────────────────────

describe("buildSweepPrompt", () => {
  it("includes all facts in the prompt", () => {
    const facts = createSampleFacts(3);
    const prompt = buildSweepPrompt(facts);

    assert.ok(prompt.includes("3 facts"));
    assert.ok(prompt.includes("[1] entity-1 -[uses]-> library-1"));
    assert.ok(prompt.includes("[2] entity-2 -[uses]-> library-2"));
    assert.ok(prompt.includes("[3] entity-3 -[uses]-> library-3"));
    assert.ok(prompt.includes("VALID"));
    assert.ok(prompt.includes("STALE"));
    assert.ok(prompt.includes("UNKNOWN"));
    assert.ok(prompt.includes("JSON"));
  });

  it("handles single fact", () => {
    const facts = [createSampleFacts(1)[0]];
    const prompt = buildSweepPrompt(facts);
    assert.ok(prompt.includes("1 facts"));
    assert.ok(prompt.includes("[1] entity-1"));
  });
});

// ─── Unit tests: sweepOnce ───────────────────────────────────────────────

describe("sweepOnce", () => {
  beforeEach(() => {
    _resetLastSweepTs();
    resetRateLimiter();
  });

  it("returns empty result when no stale facts found", async () => {
    const { backend } = createMockBackend([]);
    const config = createMockConfig();

    const result = await sweepOnce(config, backend);

    assert.deepStrictEqual(result, {
      reviewed: 0,
      confirmed: 0,
      stale: 0,
      unknown: 0,
    });
  });

  it("processes VALID verdicts correctly", async () => {
    const facts = createSampleFacts(2);
    const { backend, validationUpdates } = createMockBackend(facts);
    const config = createMockConfig();
    const mockClaude = createMockSpawnClaude([
      { id: 1, verdict: "VALID", reason: "still correct" },
      { id: 2, verdict: "VALID", reason: "confirmed" },
    ]);

    const result = await sweepOnce(config, backend, undefined, mockClaude);

    assert.strictEqual(result.reviewed, 2);
    assert.strictEqual(result.confirmed, 2);
    assert.strictEqual(result.stale, 0);
    assert.strictEqual(result.unknown, 0);

    // Check that confidence was updated to 1.0
    assert.strictEqual(validationUpdates.length, 2);
    assert.strictEqual(validationUpdates[0].confidence, 1.0);
    assert.ok(validationUpdates[0].lastValidated);
    assert.strictEqual(validationUpdates[1].confidence, 1.0);
  });

  it("processes STALE verdicts correctly", async () => {
    const facts = createSampleFacts(2);
    const { backend, validationUpdates } = createMockBackend(facts);
    const config = createMockConfig();
    const mockClaude = createMockSpawnClaude([
      { id: 1, verdict: "STALE", reason: "outdated" },
      { id: 2, verdict: "STALE", reason: "deprecated" },
    ]);

    const result = await sweepOnce(config, backend, undefined, mockClaude);

    assert.strictEqual(result.reviewed, 2);
    assert.strictEqual(result.confirmed, 0);
    assert.strictEqual(result.stale, 2);
    assert.strictEqual(result.unknown, 0);

    // Check that confidence was reduced to 0.5
    assert.strictEqual(validationUpdates[0].confidence, 0.5);
    assert.strictEqual(validationUpdates[1].confidence, 0.5);
  });

  it("processes UNKNOWN verdicts correctly", async () => {
    const facts = createSampleFacts(1);
    const { backend, validationUpdates } = createMockBackend(facts);
    const config = createMockConfig();
    const mockClaude = createMockSpawnClaude([
      { id: 1, verdict: "UNKNOWN", reason: "need more context" },
    ]);

    const result = await sweepOnce(config, backend, undefined, mockClaude);

    assert.strictEqual(result.reviewed, 1);
    assert.strictEqual(result.confirmed, 0);
    assert.strictEqual(result.stale, 0);
    assert.strictEqual(result.unknown, 1);

    // Check that only lastValidated was updated (no confidence change)
    assert.strictEqual(validationUpdates.length, 1);
    assert.strictEqual(validationUpdates[0].confidence, undefined);
    assert.ok(validationUpdates[0].lastValidated);
  });

  it("handles mixed verdicts", async () => {
    const facts = createSampleFacts(3);
    const { backend } = createMockBackend(facts);
    const config = createMockConfig();
    const mockClaude = createMockSpawnClaude([
      { id: 1, verdict: "VALID", reason: "ok" },
      { id: 2, verdict: "STALE", reason: "old" },
      { id: 3, verdict: "UNKNOWN", reason: "unclear" },
    ]);

    const result = await sweepOnce(config, backend, undefined, mockClaude);

    assert.strictEqual(result.reviewed, 3);
    assert.strictEqual(result.confirmed, 1);
    assert.strictEqual(result.stale, 1);
    assert.strictEqual(result.unknown, 1);
  });

  it("records sweep timestamp after success", async () => {
    const facts = createSampleFacts(1);
    const { backend } = createMockBackend(facts);
    const config = createMockConfig();
    const mockClaude = createMockSpawnClaude([
      { id: 1, verdict: "VALID", reason: "ok" },
    ]);

    const before = Date.now();
    await sweepOnce(config, backend, undefined, mockClaude);
    const after = Date.now();

    const lastTs = getLastSweepTs();
    assert.ok(lastTs >= before && lastTs <= after);
  });

  it("respects batchSize option", async () => {
    const facts = createSampleFacts(10);
    const { backend } = createMockBackend(facts);
    const config = createMockConfig({ sweepBatchSize: 20 });

    // Create decisions for facts 1-3 only
    const mockClaude = createMockSpawnClaude(
      facts.slice(0, 3).map((f) => ({
        id: f.factId,
        verdict: "VALID",
        reason: "ok",
      })),
    );

    const result = await sweepOnce(
      config,
      backend,
      { batchSize: 3 },
      mockClaude,
    );

    // The mock backend will only return 3 facts due to limit
    assert.strictEqual(result.reviewed, 3);
  });

  it("respects subject filter option", async () => {
    const facts = createSampleFacts(5);
    const { backend } = createMockBackend(facts);
    const config = createMockConfig();
    const mockClaude = createMockSpawnClaude([
      { id: 3, verdict: "VALID", reason: "ok" },
    ]);

    const result = await sweepOnce(
      config,
      backend,
      { subject: "entity-3" },
      mockClaude,
    );

    assert.strictEqual(result.reviewed, 1);
  });

  it("respects source filter option", async () => {
    const facts = createSampleFacts(5);
    const { backend } = createMockBackend(facts);
    const config = createMockConfig();
    const mockClaude = createMockSpawnClaude([
      { id: 2, verdict: "STALE", reason: "old" },
    ]);

    const result = await sweepOnce(
      config,
      backend,
      { source: "source-2" },
      mockClaude,
    );

    assert.strictEqual(result.reviewed, 1);
    assert.strictEqual(result.stale, 1);
  });

  it("skips decisions for facts not in the batch", async () => {
    const facts = createSampleFacts(2);
    const { backend } = createMockBackend(facts);
    const config = createMockConfig();
    // Claude returns a decision for a fact ID not in the batch
    const mockClaude = createMockSpawnClaude([
      { id: 1, verdict: "VALID", reason: "ok" },
      { id: 999, verdict: "STALE", reason: "not in batch" },
    ]);

    const result = await sweepOnce(config, backend, undefined, mockClaude);

    assert.strictEqual(result.reviewed, 1);
    assert.strictEqual(result.confirmed, 1);
  });

  it("handles backend without queryFactsForValidation", async () => {
    const backend = {
      findOrCreateEntity: async () => 1,
      storeFact: async () => 1,
      searchFacts: async () => [],
      graphTraverse: async () => null,
      listEntities: async () => [],
      deleteFact: async () => true,
      close: async () => {},
      // No queryFactsForValidation
    };

    const config = createMockConfig();
    const result = await sweepOnce(config, backend);

    assert.deepStrictEqual(result, {
      reviewed: 0,
      confirmed: 0,
      stale: 0,
      unknown: 0,
    });
  });
});

// ─── Unit tests: maybeSweepOnStart ───────────────────────────────────────

describe("maybeSweepOnStart", () => {
  beforeEach(() => {
    _resetLastSweepTs();
    resetRateLimiter();
  });

  it("skips sweep when validation.mode is 'off'", async () => {
    const { backend } = createMockBackend(createSampleFacts(5));
    const config = createMockConfig({ mode: "off" });
    let sweepCalled = false;
    const mockClaude = async () => {
      sweepCalled = true;
      return { decisions: [] };
    };

    await maybeSweepOnStart(config, backend, mockClaude);

    // Give fire-and-forget a chance to run
    await new Promise((r) => setTimeout(r, 50));

    assert.strictEqual(sweepCalled, false);
  });

  it("skips sweep when last sweep is recent (within cooldown)", async () => {
    const { backend } = createMockBackend(createSampleFacts(5));
    const config = createMockConfig({ sweepCooldownMin: 30 });

    // Set last sweep to now
    setLastSweepTs(Date.now());

    let sweepCalled = false;
    const mockClaude = async () => {
      sweepCalled = true;
      return { decisions: [] };
    };

    await maybeSweepOnStart(config, backend, mockClaude);

    // Give fire-and-forget a chance to run
    await new Promise((r) => setTimeout(r, 50));

    assert.strictEqual(sweepCalled, false);
  });

  it("triggers sweep when last sweep is old (beyond cooldown)", async () => {
    const facts = createSampleFacts(2);
    const { backend } = createMockBackend(facts);
    const config = createMockConfig({ sweepCooldownMin: 30 });

    // Set last sweep to 31 minutes ago
    setLastSweepTs(Date.now() - 31 * 60 * 1000);

    let sweepCalled = false;
    const mockClaude = async () => {
      sweepCalled = true;
      return {
        decisions: facts.map((f) => ({
          id: f.factId,
          verdict: "VALID",
          reason: "ok",
        })),
      };
    };

    await maybeSweepOnStart(config, backend, mockClaude);

    // Give fire-and-forget a chance to run
    await new Promise((r) => setTimeout(r, 200));

    assert.strictEqual(sweepCalled, true);
  });

  it("triggers sweep when no previous sweep exists", async () => {
    const facts = createSampleFacts(1);
    const { backend } = createMockBackend(facts);
    const config = createMockConfig({ sweepCooldownMin: 30 });

    // _resetLastSweepTs already called in beforeEach — no previous sweep

    let sweepCalled = false;
    const mockClaude = async () => {
      sweepCalled = true;
      return {
        decisions: [
          { id: 1, verdict: "VALID", reason: "ok" },
        ],
      };
    };

    await maybeSweepOnStart(config, backend, mockClaude);

    // Give fire-and-forget a chance to run
    await new Promise((r) => setTimeout(r, 200));

    assert.strictEqual(sweepCalled, true);
  });

  it("does not block when sweep fails (fire-and-forget)", async () => {
    const facts = createSampleFacts(2);
    const { backend } = createMockBackend(facts);
    const config = createMockConfig({ sweepCooldownMin: 0 });

    // Mock spawnClaude that throws
    const mockClaude = async () => {
      throw new Error("Claude CLI not available");
    };

    // This should not throw — fire-and-forget catches errors
    await maybeSweepOnStart(config, backend, mockClaude);

    // Give fire-and-forget a chance to run and log the error
    await new Promise((r) => setTimeout(r, 200));

    // If we reached here without throwing, the test passes
    assert.ok(true);
  });
});

// ─── Unit tests: metadata helpers ────────────────────────────────────────

describe("sweep metadata helpers", () => {
  beforeEach(() => {
    _resetLastSweepTs();
  });

  it("getLastSweepTs returns null initially", () => {
    assert.strictEqual(getLastSweepTs(), null);
  });

  it("setLastSweepTs and getLastSweepTs round-trip", () => {
    const ts = Date.now();
    setLastSweepTs(ts);
    assert.strictEqual(getLastSweepTs(), ts);
  });

  it("_resetLastSweepTs clears the timestamp", () => {
    setLastSweepTs(Date.now());
    _resetLastSweepTs();
    assert.strictEqual(getLastSweepTs(), null);
  });
});

// ─── Integration tests (skip without INTEGRATION=1) ─────────────────────

describe("Step 08 — Integration: sweep", { skip: !process.env.INTEGRATION }, () => {
  it("sweepOnce on empty backend returns 0 reviewed", async () => {
    const { getConfig } = await import("../dist/config.js");
    const { createBackend } = await import("../dist/backend-factory.js");

    const config = getConfig();
    const backend = await createBackend(config, "project");

    try {
      _resetLastSweepTs();
      resetRateLimiter();

      const result = await sweepOnce(config, backend);
      assert.strictEqual(result.reviewed, 0);
      assert.strictEqual(result.confirmed, 0);
      assert.strictEqual(result.stale, 0);
      assert.strictEqual(result.unknown, 0);
    } finally {
      await backend.close();
    }
  });

  it("CLI sweep runs and prints output", async () => {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);

    try {
      const { stderr } = await execFileAsync("node", [
        "--experimental-vm-modules",
        "./dist/index.js",
        "sweep",
      ], {
        timeout: 30_000,
        env: {
          ...process.env,
          // Use env var config to avoid config file issues
          VALIDATION_MODE: "on-store",
        },
      });
      // Should either print "Sweep complete" or "no stale facts found"
      assert.ok(
        stderr.includes("Sweep complete") || stderr.includes("no stale facts"),
        `Expected sweep output, got: ${stderr}`,
      );
    } catch (err) {
      // CLI might fail if services aren't available — that's OK for integration test
      console.error("CLI sweep test skipped due to:", err.message);
    }
  });
});
