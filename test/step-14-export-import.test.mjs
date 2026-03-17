import { describe, it } from "node:test";
import assert from "node:assert";

// Import the pure functions from built dist
import { serializeFactToJsonl, matchSourcePattern } from "../dist/cli/export.js";
import { parseJsonlLine } from "../dist/cli/import.js";

// ── Unit Tests ──────────────────────────────────────────────────────

describe("Export — serializeFactToJsonl", () => {
  it("serializes a fact to JSON without embedding field", () => {
    /** @type {import("../dist/qdrant.js").QdrantScrollPoint} */
    const point = {
      id: 42,
      payload: {
        layer: "project",
        subject: "iam-service",
        predicate: "validates_tokens_via",
        object: "jwt-rs256",
        fact: "IAM service validates JWT tokens via RS256",
        context: "from auth.ts",
        source: "iam-auth-service",
        scope_candidate: null,
        created_at: "2026-03-15T10:00:00Z",
      },
    };

    const line = serializeFactToJsonl(point);
    const parsed = JSON.parse(line);

    assert.strictEqual(parsed.subject, "iam-service");
    assert.strictEqual(parsed.predicate, "validates_tokens_via");
    assert.strictEqual(parsed.object, "jwt-rs256");
    assert.strictEqual(parsed.fact, "IAM service validates JWT tokens via RS256");
    assert.strictEqual(parsed.context, "from auth.ts");
    assert.strictEqual(parsed.source, "iam-auth-service");
    assert.strictEqual(parsed.created_at, "2026-03-15T10:00:00Z");

    // Must NOT contain embedding, vector, layer, id, scope_candidate
    assert.strictEqual(parsed.embedding, undefined);
    assert.strictEqual(parsed.vector, undefined);
    assert.strictEqual(parsed.layer, undefined);
    assert.strictEqual(parsed.id, undefined);
    assert.strictEqual(parsed.scope_candidate, undefined);
  });

  it("produces valid single-line JSON (no newlines)", () => {
    const point = {
      id: 1,
      payload: {
        layer: null,
        subject: "a",
        predicate: "b",
        object: "c",
        fact: "multiline\nfact\ndescription",
        context: "ctx",
        source: "src",
        scope_candidate: null,
        created_at: "2026-01-01T00:00:00Z",
      },
    };

    const line = serializeFactToJsonl(point);
    // JSON.stringify escapes newlines to \n, so no literal newlines in output
    assert.ok(!line.includes("\n"), "JSONL line must not contain literal newlines");
    // But the parsed fact should retain them
    const parsed = JSON.parse(line);
    assert.ok(parsed.fact.includes("\n"));
  });
});

describe("Export — matchSourcePattern", () => {
  it("matches exact source string", () => {
    assert.ok(matchSourcePattern("iam-auth-service", "iam-auth-service"));
  });

  it("does not match different source", () => {
    assert.ok(!matchSourcePattern("iam-auth-service", "billing-service"));
  });

  it("matches prefix pattern with wildcard *", () => {
    assert.ok(matchSourcePattern("platform-lib:changelog", "platform-lib:*"));
    assert.ok(matchSourcePattern("platform-lib:v2.4", "platform-lib:*"));
    assert.ok(matchSourcePattern("platform-lib:", "platform-lib:*"));
  });

  it("does not match unrelated source with wildcard", () => {
    assert.ok(!matchSourcePattern("billing:v1", "platform-lib:*"));
  });

  it("handles wildcard at end of empty prefix", () => {
    // "*" should match everything
    assert.ok(matchSourcePattern("anything", "*"));
    assert.ok(matchSourcePattern("", "*"));
  });
});

describe("Import — parseJsonlLine", () => {
  it("parses a valid JSONL line into ExportRecord", () => {
    const line = JSON.stringify({
      subject: "iam-service",
      predicate: "validates_tokens_via",
      object: "jwt-rs256",
      fact: "IAM validates JWT",
      context: "auth.ts",
      source: "iam",
      created_at: "2026-03-15T10:00:00Z",
    });

    const result = parseJsonlLine(line);
    assert.notStrictEqual(result, null);
    assert.strictEqual(result.subject, "iam-service");
    assert.strictEqual(result.predicate, "validates_tokens_via");
    assert.strictEqual(result.object, "jwt-rs256");
    assert.strictEqual(result.fact, "IAM validates JWT");
    assert.strictEqual(result.context, "auth.ts");
    assert.strictEqual(result.source, "iam");
    assert.strictEqual(result.created_at, "2026-03-15T10:00:00Z");
  });

  it("returns null for invalid JSON", () => {
    assert.strictEqual(parseJsonlLine("{not valid json"), null);
  });

  it("returns null for empty line", () => {
    assert.strictEqual(parseJsonlLine(""), null);
    assert.strictEqual(parseJsonlLine("   "), null);
  });

  it("returns null for JSON missing required fields", () => {
    // Missing subject
    assert.strictEqual(
      parseJsonlLine(JSON.stringify({ predicate: "a", object: "b", fact: "c" })),
      null,
    );
    // Missing fact
    assert.strictEqual(
      parseJsonlLine(JSON.stringify({ subject: "a", predicate: "b", object: "c" })),
      null,
    );
  });

  it("defaults optional fields when missing", () => {
    const line = JSON.stringify({
      subject: "svc",
      predicate: "uses",
      object: "pg",
      fact: "service uses postgres",
    });

    const result = parseJsonlLine(line);
    assert.notStrictEqual(result, null);
    assert.strictEqual(result.context, "");
    assert.strictEqual(result.source, "");
    assert.ok(result.created_at); // should have a default ISO date
  });

  it("handles extra fields gracefully (ignores them)", () => {
    const line = JSON.stringify({
      subject: "a",
      predicate: "b",
      object: "c",
      fact: "f",
      unknown_field: "ignored",
      version: "v3",
      confidence: 0.95,
    });

    const result = parseJsonlLine(line);
    assert.notStrictEqual(result, null);
    assert.strictEqual(result.subject, "a");
    // Extra fields should not appear on the result
    assert.strictEqual(/** @type {any} */ (result).unknown_field, undefined);
  });
});

// ── Integration Tests ───────────────────────────────────────────────

describe("Export/Import integration", { skip: !process.env.INTEGRATION }, () => {
  it("placeholder — requires INTEGRATION=1 and running Qdrant + Neo4j", () => {
    // Integration tests require:
    // 1. A running Qdrant instance (QDRANT_URL)
    // 2. A running Neo4j instance
    // 3. INTEGRATION=1 env var
    //
    // Test scenarios when infrastructure is available:
    // - Store 5 facts -> export -> verify 5 JSONL lines
    // - Export + import into clean DB -> all 5 facts present
    // - Import same file again -> all 5 detected as duplicates
    // - Export with --source filter -> only matching facts
    // - Export without --include-outdated -> superseded excluded
    // - Import with --source-override -> all facts tagged
    assert.ok(true);
  });
});
