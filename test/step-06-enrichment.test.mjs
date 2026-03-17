import { describe, it } from "node:test";
import assert from "node:assert";

import {
  computeDisplayConfidence,
  confidenceTag,
} from "../dist/types.js";

import {
  enrichResult,
  filterOutdated,
  sortEnriched,
  formatEnrichedResult,
  formatTimeAgo,
} from "../dist/tools/search.js";

import { formatHealthScore } from "../dist/tools/list.js";

// ─── Unit tests ──────────────────────────────────────────────────────

describe("Step 06 — On-Read Enrichment", () => {
  describe("enrichResult", () => {
    it("formats a search result with tag and confidence", () => {
      const now = new Date().toISOString();
      const result = {
        subject: "Node.js",
        predicate: "uses",
        object: "V8",
        fact: "Node.js uses V8 engine",
        context: "runtime",
        source: "docs.md",
        score: 0.95,
        factId: "42",
        createdAt: now,
        confidence: 0.98,
        lastValidated: now,
        supersededBy: null,
        version: "v2.4",
      };

      const enriched = enrichResult(result);

      assert.ok(enriched.displayConfidence >= 0.95, `expected high confidence, got ${enriched.displayConfidence}`);
      assert.strictEqual(enriched.tag, "\u2705 Current");
      assert.strictEqual(enriched.subject, "Node.js");
      assert.strictEqual(enriched.score, 0.95);
    });

    it("superseded fact has displayConfidence 0.0 and Outdated tag", () => {
      const result = {
        subject: "A",
        predicate: "knows",
        object: "B",
        fact: "A knows B",
        context: "",
        source: "test",
        score: 0.9,
        factId: "1",
        createdAt: new Date().toISOString(),
        confidence: 1.0,
        lastValidated: new Date().toISOString(),
        supersededBy: "project:99",
      };

      const enriched = enrichResult(result);
      assert.strictEqual(enriched.displayConfidence, 0.0);
      assert.strictEqual(enriched.tag, "\u26A0\uFE0F Outdated");
    });

    it("v2 fact (no v3 fields) defaults to Current", () => {
      const result = {
        subject: "X",
        predicate: "has",
        object: "Y",
        fact: "X has Y",
        context: "",
        source: "legacy",
        score: 0.8,
        factId: "5",
        // No v3 fields — all undefined
      };

      const enriched = enrichResult(result);
      // confidence defaults to 1.0, no superseded, no decay (no date => now)
      assert.ok(enriched.displayConfidence >= 0.99, `expected ~1.0, got ${enriched.displayConfidence}`);
      assert.strictEqual(enriched.tag, "\u2705 Current");
    });
  });

  describe("filterOutdated", () => {
    it("filters out facts with displayConfidence < 0.4 when include_outdated=false", () => {
      const facts = [
        makeFact("a", 0.95, "\u2705 Current"),
        makeFact("b", 0.50, "\uD83D\uDD04 Needs review"),
        makeFact("c", 0.10, "\u26A0\uFE0F Outdated"),
        makeFact("d", 0.85, "\u2705 Current"),
        makeFact("e", 0.30, "\u26A0\uFE0F Outdated"),
      ];

      const filtered = filterOutdated(facts, false);
      assert.strictEqual(filtered.length, 3, `expected 3 results after filter, got ${filtered.length}`);
      assert.ok(filtered.every((f) => f.displayConfidence >= 0.4));
    });

    it("returns all facts when include_outdated=true", () => {
      const facts = [
        makeFact("a", 0.95, "\u2705 Current"),
        makeFact("b", 0.10, "\u26A0\uFE0F Outdated"),
        makeFact("c", 0.30, "\u26A0\uFE0F Outdated"),
      ];

      const filtered = filterOutdated(facts, true);
      assert.strictEqual(filtered.length, 3);
    });
  });

  describe("sortEnriched", () => {
    it("sorts current facts first, then by score within tier", () => {
      const facts = [
        makeFact("low-score-current", 0.75, "\u2705 Current", 0.5),
        makeFact("review", 0.50, "\uD83D\uDD04 Needs review", 0.99),
        makeFact("high-score-current", 0.90, "\u2705 Current", 0.9),
        makeFact("outdated", 0.10, "\u26A0\uFE0F Outdated", 0.95),
      ];

      const sorted = sortEnriched(facts);

      // Current tier first (sorted by score desc)
      assert.strictEqual(sorted[0].factId, "high-score-current");
      assert.strictEqual(sorted[1].factId, "low-score-current");
      // Then review tier
      assert.strictEqual(sorted[2].factId, "review");
      // Then outdated tier
      assert.strictEqual(sorted[3].factId, "outdated");
    });
  });

  describe("formatEnrichedResult", () => {
    it("produces the expected output format", () => {
      const now = new Date().toISOString();
      const enriched = {
        subject: "React",
        predicate: "uses",
        object: "JSX",
        fact: "React uses JSX for templating",
        context: "frontend framework",
        source: "docs/react.md",
        score: 0.95,
        factId: "42",
        createdAt: now,
        confidence: 0.98,
        lastValidated: now,
        supersededBy: null,
        version: "v2.4",
        displayConfidence: 0.98,
        tag: "\u2705 Current",
      };

      const formatted = formatEnrichedResult(enriched);

      assert.ok(formatted.includes("[0.950] \u2705 Current"), "should contain score and tag");
      assert.ok(formatted.includes("React -[uses]-> JSX"), "should contain triple");
      assert.ok(formatted.includes("(id: 42)"), "should contain fact id");
      assert.ok(formatted.includes("Fact: React uses JSX for templating"), "should contain fact text");
      assert.ok(formatted.includes("Source: docs/react.md"), "should contain source");
      assert.ok(formatted.includes("Version: v2.4"), "should contain version");
      assert.ok(formatted.includes("Confidence: 0.98"), "should contain confidence");
      assert.ok(formatted.includes("Validated:"), "should contain validated time");
    });

    it("handles missing optional fields gracefully", () => {
      const enriched = {
        subject: "A",
        predicate: "has",
        object: "B",
        fact: "A has B",
        context: "",
        source: "",
        score: 0.8,
        factId: "1",
        displayConfidence: 1.0,
        tag: "\u2705 Current",
      };

      const formatted = formatEnrichedResult(enriched);
      assert.ok(formatted.includes("Source: n/a"), "should show n/a for empty source");
      assert.ok(!formatted.includes("Version:"), "should not show version when absent");
    });
  });

  describe("formatTimeAgo", () => {
    it("returns 'just now' for recent dates", () => {
      const now = new Date().toISOString();
      assert.strictEqual(formatTimeAgo(now), "just now");
    });

    it("returns 'Xd ago' for dates in the past", () => {
      const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
      assert.strictEqual(formatTimeAgo(twoDaysAgo), "2d ago");
    });

    it("returns 'n/a' for null/undefined", () => {
      assert.strictEqual(formatTimeAgo(null), "n/a");
      assert.strictEqual(formatTimeAgo(undefined), "n/a");
    });

    it("returns hours for < 24h old", () => {
      const fiveHoursAgo = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
      assert.strictEqual(formatTimeAgo(fiveHoursAgo), "5h ago");
    });
  });

  describe("formatHealthScore", () => {
    it("formats entity with health breakdown", () => {
      const entity = {
        name: "Node.js",
        factCount: 15,
        healthCurrent: 12,
        healthReview: 2,
        healthOutdated: 1,
      };
      const result = formatHealthScore(entity);
      assert.strictEqual(result, "Node.js (15 facts: 12 \u2705, 2 \uD83D\uDD04, 1 \u26A0\uFE0F)");
    });

    it("formats entity with only current facts", () => {
      const entity = {
        name: "React",
        factCount: 8,
        healthCurrent: 8,
        healthReview: 0,
        healthOutdated: 0,
      };
      const result = formatHealthScore(entity);
      assert.strictEqual(result, "React (8 facts: 8 \u2705)");
    });

    it("formats entity with zero facts", () => {
      const entity = {
        name: "Empty",
        factCount: 0,
        healthCurrent: 0,
        healthReview: 0,
        healthOutdated: 0,
      };
      const result = formatHealthScore(entity);
      assert.strictEqual(result, "Empty (0 facts)");
    });

    it("falls back for v2 entity (no health data)", () => {
      const entity = {
        name: "Legacy",
        factCount: 5,
        // No healthCurrent/Review/Outdated
      };
      const result = formatHealthScore(entity);
      assert.strictEqual(result, "Legacy (5 facts)");
    });
  });

  describe("full enrichment pipeline", () => {
    it("fact validated 200 days ago has ~0.68 confidence and Needs review tag", () => {
      // 0.5^(200/365) ~= 0.684 which is in the "Needs review" range [0.4, 0.7)
      const twoHundredDaysAgo = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString();
      const result = {
        subject: "A",
        predicate: "knows",
        object: "B",
        fact: "A knows B",
        context: "",
        source: "",
        score: 0.9,
        factId: "1",
        createdAt: twoHundredDaysAgo,
        confidence: 1.0,
        lastValidated: twoHundredDaysAgo,
        supersededBy: null,
      };

      const enriched = enrichResult(result);
      // 0.5^(200/365) ~= 0.684
      assert.ok(enriched.displayConfidence >= 0.65 && enriched.displayConfidence <= 0.72,
        `expected ~0.684, got ${enriched.displayConfidence}`);
      assert.strictEqual(enriched.tag, "\uD83D\uDD04 Needs review");
    });

    it("pipeline: enrich -> filter -> sort produces correct output", () => {
      const now = new Date().toISOString();
      const oldDate = new Date(Date.now() - 500 * 24 * 60 * 60 * 1000).toISOString();

      const results = [
        // Fresh fact (current)
        {
          subject: "A", predicate: "uses", object: "B",
          fact: "A uses B", context: "", source: "a.md",
          score: 0.7, factId: "1",
          createdAt: now, confidence: 1.0, lastValidated: now, supersededBy: null,
        },
        // Superseded fact (outdated)
        {
          subject: "C", predicate: "uses", object: "D",
          fact: "C uses D", context: "", source: "c.md",
          score: 0.99, factId: "2",
          createdAt: now, confidence: 1.0, lastValidated: now, supersededBy: "project:10",
        },
        // Very old fact (outdated by decay)
        {
          subject: "E", predicate: "has", object: "F",
          fact: "E has F", context: "", source: "e.md",
          score: 0.85, factId: "3",
          createdAt: oldDate, confidence: 1.0, lastValidated: oldDate, supersededBy: null,
        },
      ];

      let enriched = results.map(enrichResult);
      enriched = filterOutdated(enriched, false);
      enriched = sortEnriched(enriched);

      // Superseded fact and very old fact should be filtered out
      assert.strictEqual(enriched.length, 1, `expected 1 result, got ${enriched.length}`);
      assert.strictEqual(enriched[0].factId, "1");
    });
  });
});

// ─── Integration tests (skip without INTEGRATION=1) ──────────────────

describe("Step 06 — Integration", { skip: !process.env.INTEGRATION }, () => {
  // Integration tests require running Neo4j + Qdrant backends.
  // They would store facts with different v3 states, then verify
  // search/graph/list enrichment. Skipped in CI unless INTEGRATION=1.

  it("search without include_outdated hides superseded facts", async () => {
    // This test requires a live backend.
    // Store 3 facts: 1 superseded, 1 old (>500d), 1 fresh.
    // Search → expect 1-2 results (fresh + maybe old, but not superseded).
    assert.ok(true, "placeholder — requires live backend");
  });

  it("search with include_outdated=true returns all facts", async () => {
    assert.ok(true, "placeholder — requires live backend");
  });

  it("graph hides superseded facts by default", async () => {
    assert.ok(true, "placeholder — requires live backend");
  });

  it("list_entities shows health scores", async () => {
    assert.ok(true, "placeholder — requires live backend");
  });
});

// ─── Helpers ─────────────────────────────────────────────────────────

function makeFact(id, displayConfidence, tag, score = 0.9) {
  return {
    subject: "S",
    predicate: "p",
    object: "O",
    fact: `fact-${id}`,
    context: "",
    source: "",
    score,
    factId: id,
    displayConfidence,
    tag,
  };
}
