import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { StorageBackend, EmbedFn, SearchResult } from "../types.js";
import type { Config } from "../config.js";
import { buildDescription } from "../triggers.js";
import { computeDisplayConfidence, confidenceTag } from "../types.js";

/** Format "X days ago" / "Xh ago" for validated date */
export function formatTimeAgo(isoDate: string | undefined | null): string {
  if (!isoDate) return "n/a";
  const ms = Date.now() - new Date(isoDate).getTime();
  if (ms < 0) return "just now";
  const hours = Math.floor(ms / (1000 * 60 * 60));
  if (hours < 1) return "just now";
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/** Enriched search result with computed display confidence and tag */
export interface EnrichedSearchResult extends SearchResult {
  displayConfidence: number;
  tag: string;
}

/** Compute enrichment fields for a single search result */
export function enrichResult(r: SearchResult): EnrichedSearchResult {
  const dc = computeDisplayConfidence({
    confidence: r.confidence ?? 1.0,
    last_validated: r.lastValidated ?? null,
    created_at: r.createdAt ?? null,
    superseded_by: r.supersededBy ?? null,
  });
  return {
    ...r,
    displayConfidence: dc,
    tag: confidenceTag(dc),
  };
}

/**
 * Filter out outdated results (displayConfidence < 0.4)
 * unless include_outdated is true.
 */
export function filterOutdated(
  results: EnrichedSearchResult[],
  includeOutdated: boolean,
): EnrichedSearchResult[] {
  if (includeOutdated) return results;
  return results.filter((r) => r.displayConfidence >= 0.4);
}

/**
 * Sort: current facts first (by tag tier), then by similarity score within each tier.
 * Tier order: Current (>= 0.7) > Needs review (>= 0.4) > Outdated (< 0.4)
 */
export function sortEnriched(results: EnrichedSearchResult[]): EnrichedSearchResult[] {
  return [...results].sort((a, b) => {
    const tierA = a.displayConfidence >= 0.7 ? 0 : a.displayConfidence >= 0.4 ? 1 : 2;
    const tierB = b.displayConfidence >= 0.7 ? 0 : b.displayConfidence >= 0.4 ? 1 : 2;
    if (tierA !== tierB) return tierA - tierB;
    return b.score - a.score;
  });
}

/** Format a single enriched result line */
export function formatEnrichedResult(r: EnrichedSearchResult): string {
  const scorePart = `[${r.score.toFixed(3)}] ${r.tag}`;
  const triplePart = `${r.subject} -[${r.predicate}]-> ${r.object}`;
  const validatedAgo = formatTimeAgo(r.lastValidated ?? r.createdAt);
  const versionPart = r.version ? ` | Version: ${r.version}` : "";
  const confidencePart = r.confidence != null ? ` | Confidence: ${r.confidence.toFixed(2)}` : "";

  return (
    `${scorePart} | ${triplePart}\n` +
    `  (id: ${r.factId}) Fact: ${r.fact}\n` +
    `  Context: ${r.context}\n` +
    `  Source: ${r.source || "n/a"}${versionPart}${confidencePart} | Validated: ${validatedAgo}`
  );
}

export function registerSearchTool(
  server: McpServer,
  db: StorageBackend,
  embed: EmbedFn,
  config: Config
): void {
  server.tool(
    "memory_search",
    buildDescription("search", config.triggersSearch),
    {
      query: z.string().describe("Search query in any language"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .describe("Max results (default 5)"),
      predicates: z
        .array(z.string())
        .optional()
        .describe("Filter by predicate types (e.g. ['uses', 'depends_on'])"),
      source: z
        .string()
        .optional()
        .describe("Filter by source path or URL"),
      since: z
        .string()
        .optional()
        .describe("Only facts created after this date (ISO 8601, e.g. '2026-03-01')"),
      recency_bias: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe("Weight for recency vs similarity (0=similarity only, 1=recency only, default 0)"),
      include_outdated: z
        .boolean()
        .optional()
        .describe("Include outdated/superseded facts (default: false)"),
    },
    async ({ query, limit, predicates, source, since, recency_bias, include_outdated }) => {
      const queryEmb = await embed(query);
      const effectiveLimit = limit ?? 5;
      const includeOutdated = include_outdated ?? false;

      const hasFilters = predicates || source || since || recency_bias;

      // Request extra results to compensate for post-filter removal of outdated facts
      const fetchLimit = includeOutdated ? effectiveLimit : Math.min(effectiveLimit * 2, 50);

      let results: SearchResult[];
      if (hasFilters && db.searchFactsFiltered) {
        results = await db.searchFactsFiltered(queryEmb, fetchLimit, {
          predicates,
          source,
          since,
          recencyBias: recency_bias,
        });
      } else {
        results = await db.searchFacts(queryEmb, fetchLimit);
      }

      if (results.length === 0) {
        return {
          content: [{ type: "text" as const, text: "No matching facts found." }],
        };
      }

      // Enrich, filter, sort
      let enriched = results.map(enrichResult);
      enriched = filterOutdated(enriched, includeOutdated);
      enriched = sortEnriched(enriched);

      // Apply final limit
      enriched = enriched.slice(0, effectiveLimit);

      if (enriched.length === 0) {
        return {
          content: [{ type: "text" as const, text: "No matching facts found (all results are outdated). Try include_outdated: true." }],
        };
      }

      const lines = enriched.map(formatEnrichedResult);

      return {
        content: [{ type: "text" as const, text: lines.join("\n\n") }],
      };
    }
  );
}
