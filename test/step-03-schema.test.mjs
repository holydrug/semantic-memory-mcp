import { describe, it } from "node:test";
import assert from "node:assert";

// Import from compiled dist — these are pure functions, no backend needed.
import {
  computeDisplayConfidence,
  confidenceTag,
} from "../dist/types.js";
import { normalizePayload } from "../dist/qdrant.js";

describe("Step 03 — Fact Schema v3", () => {
  describe("computeDisplayConfidence", () => {
    it("fact validated today has confidence ~1.0", () => {
      const now = new Date().toISOString();
      const dc = computeDisplayConfidence({
        confidence: 1.0,
        last_validated: now,
        created_at: now,
        superseded_by: null,
      });
      // Decay for 0 days: 0.5^(0/365) = 1.0
      assert.ok(dc >= 0.99, `expected ~1.0, got ${dc}`);
    });

    it("fact validated 90 days ago has confidence ~0.83", () => {
      const ninetyDaysAgo = new Date(
        Date.now() - 90 * 24 * 60 * 60 * 1000,
      ).toISOString();
      const dc = computeDisplayConfidence({
        confidence: 1.0,
        last_validated: ninetyDaysAgo,
        created_at: ninetyDaysAgo,
        superseded_by: null,
      });
      // 0.5^(90/365) ≈ 0.826
      assert.ok(dc >= 0.80 && dc <= 0.86, `expected ~0.83, got ${dc}`);
    });

    it("fact validated 365 days ago has confidence ~0.50", () => {
      const oneYearAgo = new Date(
        Date.now() - 365 * 24 * 60 * 60 * 1000,
      ).toISOString();
      const dc = computeDisplayConfidence({
        confidence: 1.0,
        last_validated: oneYearAgo,
        created_at: oneYearAgo,
        superseded_by: null,
      });
      // 0.5^(365/365) = 0.5
      assert.ok(dc >= 0.48 && dc <= 0.52, `expected ~0.50, got ${dc}`);
    });

    it("superseded fact always returns 0.0", () => {
      const dc = computeDisplayConfidence({
        confidence: 1.0,
        last_validated: new Date().toISOString(),
        created_at: new Date().toISOString(),
        superseded_by: "project:42",
      });
      assert.strictEqual(dc, 0.0);
    });

    it("uses stored confidence as upper bound", () => {
      const now = new Date().toISOString();
      const dc = computeDisplayConfidence({
        confidence: 0.5,
        last_validated: now,
        created_at: now,
        superseded_by: null,
      });
      // Decay for 0 days = 1.0, but min(0.5, 1.0) = 0.5
      assert.ok(dc <= 0.51 && dc >= 0.49, `expected ~0.5, got ${dc}`);
    });

    it("falls back to created_at when last_validated is null", () => {
      const ninetyDaysAgo = new Date(
        Date.now() - 90 * 24 * 60 * 60 * 1000,
      ).toISOString();
      const dc = computeDisplayConfidence({
        confidence: 1.0,
        last_validated: null,
        created_at: ninetyDaysAgo,
        superseded_by: null,
      });
      assert.ok(dc >= 0.80 && dc <= 0.86, `expected ~0.83, got ${dc}`);
    });
  });

  describe("confidenceTag", () => {
    it('>= 0.7 -> "✅ Current"', () => {
      assert.strictEqual(confidenceTag(0.95), "✅ Current");
      assert.strictEqual(confidenceTag(0.7), "✅ Current");
    });

    it('>= 0.4 -> "🔄 Needs review"', () => {
      assert.strictEqual(confidenceTag(0.5), "🔄 Needs review");
      assert.strictEqual(confidenceTag(0.4), "🔄 Needs review");
    });

    it('< 0.4 -> "⚠️ Outdated"', () => {
      assert.strictEqual(confidenceTag(0.2), "⚠️ Outdated");
      assert.strictEqual(confidenceTag(0.0), "⚠️ Outdated");
      assert.strictEqual(confidenceTag(0.39), "⚠️ Outdated");
    });
  });

  describe("normalizePayload (v2 compat)", () => {
    it("fills in v3 defaults for a v2 payload (no new fields)", () => {
      const v2Payload = {
        layer: "project",
        subject: "Node.js",
        predicate: "has_version",
        object: "18",
        fact: "Node.js has version 18",
        context: "test context",
        source: "test",
        scope_candidate: null,
        created_at: "2025-01-15T10:00:00.000Z",
      };

      const normalized = normalizePayload(v2Payload);

      // Original fields preserved
      assert.strictEqual(normalized.layer, "project");
      assert.strictEqual(normalized.subject, "Node.js");
      assert.strictEqual(normalized.predicate, "has_version");
      assert.strictEqual(normalized.object, "18");
      assert.strictEqual(normalized.fact, "Node.js has version 18");
      assert.strictEqual(normalized.context, "test context");
      assert.strictEqual(normalized.source, "test");
      assert.strictEqual(normalized.scope_candidate, null);
      assert.strictEqual(normalized.created_at, "2025-01-15T10:00:00.000Z");

      // v3 defaults
      assert.strictEqual(normalized.version, null);
      assert.strictEqual(normalized.valid_from, null);
      assert.strictEqual(normalized.valid_until, null);
      assert.strictEqual(normalized.superseded_by, null);
      assert.strictEqual(normalized.confidence, 1.0);
      assert.strictEqual(
        normalized.last_validated,
        "2025-01-15T10:00:00.000Z",
        "last_validated should default to created_at",
      );
    });

    it("preserves v3 fields when present", () => {
      const v3Payload = {
        layer: null,
        subject: "React",
        predicate: "uses",
        object: "JSX",
        fact: "React uses JSX",
        context: "",
        source: "docs",
        scope_candidate: null,
        created_at: "2025-06-01T12:00:00.000Z",
        version: "18.2",
        valid_from: "2025-06-01T12:00:00.000Z",
        valid_until: null,
        superseded_by: null,
        confidence: 0.95,
        last_validated: "2025-06-15T12:00:00.000Z",
      };

      const normalized = normalizePayload(v3Payload);

      assert.strictEqual(normalized.version, "18.2");
      assert.strictEqual(normalized.valid_from, "2025-06-01T12:00:00.000Z");
      assert.strictEqual(normalized.valid_until, null);
      assert.strictEqual(normalized.superseded_by, null);
      assert.strictEqual(normalized.confidence, 0.95);
      assert.strictEqual(normalized.last_validated, "2025-06-15T12:00:00.000Z");
    });

    it("handles empty/minimal payload gracefully", () => {
      const minimal = {};
      const normalized = normalizePayload(minimal);

      assert.strictEqual(normalized.layer, null);
      assert.strictEqual(normalized.subject, "");
      assert.strictEqual(normalized.confidence, 1.0);
      assert.strictEqual(normalized.version, null);
      assert.strictEqual(normalized.superseded_by, null);
      // last_validated and created_at should be set to current time (approximately)
      assert.ok(normalized.created_at, "created_at should be set");
      assert.ok(normalized.last_validated, "last_validated should be set");
    });

    it("handles confidence of 0 correctly (not treated as missing)", () => {
      const payload = {
        confidence: 0,
        created_at: "2025-01-01T00:00:00.000Z",
      };
      const normalized = normalizePayload(payload);
      assert.strictEqual(
        normalized.confidence,
        0,
        "confidence=0 should not be overridden with default 1.0",
      );
    });
  });

  describe("SearchResult v3 fields", () => {
    it("SearchResult type accepts v3 fields", () => {
      // This is a compile-time check that the types work correctly.
      // At runtime, we just verify the shape.
      /** @type {import('../dist/types.js').SearchResult} */
      const result = {
        subject: "A",
        predicate: "knows",
        object: "B",
        fact: "A knows B",
        context: "",
        source: "test",
        score: 0.9,
        factId: "42",
        // v3 fields
        version: "1.0",
        validFrom: "2025-01-01T00:00:00.000Z",
        validUntil: null,
        supersededBy: null,
        confidence: 0.95,
        lastValidated: "2025-06-01T00:00:00.000Z",
      };
      assert.strictEqual(result.confidence, 0.95);
      assert.strictEqual(result.version, "1.0");
      assert.strictEqual(result.supersededBy, null);
    });
  });

  describe("StoreFact v3 fields", () => {
    it("StoreFact type accepts v3 fields", () => {
      /** @type {import('../dist/types.js').StoreFact} */
      const fact = {
        subjectId: 1,
        predicate: "knows",
        objectId: 2,
        content: "A knows B",
        context: "",
        source: "test",
        embedding: new Float32Array([0.1, 0.2, 0.3]),
        // v3 fields
        version: "2.0",
        validFrom: "2025-01-01T00:00:00.000Z",
        validUntil: null,
        supersededBy: null,
        confidence: 0.8,
        lastValidated: "2025-06-01T00:00:00.000Z",
      };
      assert.strictEqual(fact.confidence, 0.8);
      assert.strictEqual(fact.version, "2.0");
    });

    it("StoreFact v3 fields are optional (backward compat)", () => {
      /** @type {import('../dist/types.js').StoreFact} */
      const fact = {
        subjectId: 1,
        predicate: "knows",
        objectId: 2,
        content: "A knows B",
        context: "",
        source: "test",
        embedding: new Float32Array([0.1, 0.2, 0.3]),
        // no v3 fields — this should work
      };
      assert.strictEqual(fact.confidence, undefined);
      assert.strictEqual(fact.version, undefined);
    });
  });
});
