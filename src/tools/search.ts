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
    },
    async ({ query, limit }) => {
      const queryEmb = await embed(query);
      const results = await db.searchFacts(queryEmb, limit ?? 5);

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
