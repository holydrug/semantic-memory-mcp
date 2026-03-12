import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { StorageBackend, EmbedFn } from "../types.js";
import type { Config } from "../config.js";
import { buildDescription } from "../triggers.js";

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
    },
    async ({ query, limit, predicates, source, since, recency_bias }) => {
      const queryEmb = await embed(query);
      const effectiveLimit = limit ?? 5;

      const hasFilters = predicates || source || since || recency_bias;

      let results;
      if (hasFilters && db.searchFactsFiltered) {
        results = await db.searchFactsFiltered(queryEmb, effectiveLimit, {
          predicates,
          source,
          since,
          recencyBias: recency_bias,
        });
      } else {
        results = await db.searchFacts(queryEmb, effectiveLimit);
      }

      if (results.length === 0) {
        return {
          content: [{ type: "text" as const, text: "No matching facts found." }],
        };
      }

      const lines = results.map(
        (r) =>
          `[${r.score.toFixed(3)}] (id: ${r.factId}) [${r.subject}] -[${r.predicate}]-> [${r.object}]\n` +
          `  Fact: ${r.fact}\n` +
          `  Context: ${r.context}\n` +
          `  Source: ${r.source || "n/a"}`
      );

      return {
        content: [{ type: "text" as const, text: lines.join("\n\n") }],
      };
    }
  );
}
