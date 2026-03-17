import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { StorageBackend } from "../types.js";
import type { Config } from "../config.js";
import { buildDescription } from "../triggers.js";
import { computeDisplayConfidence, confidenceTag } from "../types.js";

export function registerGraphTool(server: McpServer, db: StorageBackend, config: Config): void {
  server.tool(
    "memory_graph",
    buildDescription("graph", config.triggersGraph),
    {
      entity: z
        .string()
        .describe("Entity name to explore (fuzzy match supported)"),
      depth: z
        .number()
        .int()
        .min(1)
        .max(5)
        .optional()
        .describe("Traversal depth (default 2)"),
      include_outdated: z
        .boolean()
        .optional()
        .describe("Include outdated/superseded facts (default: false)"),
    },
    async ({ entity, depth, include_outdated }) => {
      const includeOutdated = include_outdated ?? false;
      const result = await db.graphTraverse(entity, depth ?? 2, { includeOutdated });

      if (!result) {
        return {
          content: [
            { type: "text" as const, text: `Entity '${entity}' not found.` },
          ],
        };
      }

      const lines = [`Graph around: ${result.matchedName}`];

      lines.push(
        `\nConnected entities (${result.entities.length}): ${result.entities.sort().join(", ") || "none"}`
      );

      lines.push(`\nFacts (${result.facts.length}):`);
      for (const f of result.facts) {
        // Compute confidence tag for each fact
        const dc = computeDisplayConfidence({
          confidence: f.confidence ?? 1.0,
          last_validated: f.lastValidated ?? null,
          created_at: f.createdAt ?? null,
          superseded_by: f.supersededBy ?? null,
        });
        const tag = confidenceTag(dc);

        lines.push(
          `  ${tag} (id: ${f.factId}) [${f.subject}] -[${f.predicate}]-> [${f.object}]: ${f.fact}`
        );
      }

      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
      };
    }
  );
}
