import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { StorageBackend, EntityInfo } from "../types.js";
import type { Config } from "../config.js";
import { buildDescription } from "../triggers.js";

/** Format the health score breakdown for an entity */
export function formatHealthScore(e: EntityInfo): string {
  const current = e.healthCurrent ?? 0;
  const review = e.healthReview ?? 0;
  const outdated = e.healthOutdated ?? 0;
  const total = current + review + outdated;

  // If no v3 data, fall back to basic format
  if (total === 0 && e.factCount > 0) {
    return `${e.name} (${e.factCount} facts)`;
  }
  if (total === 0) {
    return `${e.name} (0 facts)`;
  }

  const parts: string[] = [];
  if (current > 0) parts.push(`${current} \u2705`);
  if (review > 0) parts.push(`${review} \uD83D\uDD04`);
  if (outdated > 0) parts.push(`${outdated} \u26A0\uFE0F`);

  return `${e.name} (${total} facts: ${parts.join(", ")})`;
}

export function registerListTool(server: McpServer, db: StorageBackend, config: Config): void {
  server.tool(
    "memory_list_entities",
    buildDescription("list", config.triggersList),
    {
      pattern: z
        .string()
        .optional()
        .describe(
          "Optional filter pattern (case-insensitive contains match)"
        ),
    },
    async ({ pattern }) => {
      const entities = await db.listEntities(pattern);

      if (entities.length === 0) {
        return {
          content: [{ type: "text" as const, text: "No entities found." }],
        };
      }

      const lines = [`Entities (${entities.length}):`];
      for (const e of entities) {
        lines.push(`  ${formatHealthScore(e)}`);
      }

      // In dual mode, show pending global candidates count
      if (db.getCandidateFacts) {
        try {
          const candidates = await db.getCandidateFacts("project");
          if (candidates.length > 0) {
            lines.push(`\n\uD83D\uDCCC ${candidates.length} project fact(s) available for promotion. Run: npx semantic-memory-mcp promote`);
          }
        } catch {
          // ignore — backend may not support candidates
        }
      }

      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
      };
    }
  );
}
