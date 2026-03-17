import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { StorageBackend } from "../types.js";
import { isDualBackend, parseFactId } from "../types.js";
import type { Config } from "../config.js";
import { buildDescription } from "../triggers.js";

export function registerDeleteTool(
  server: McpServer,
  db: StorageBackend,
  config: Config
): void {
  server.tool(
    "memory_delete",
    buildDescription("delete", config.triggersDelete),
    {
      factIds: z
        .array(z.string())
        .min(1)
        .max(20)
        .describe(
          "Fact IDs to delete. Use memory_search or memory_graph to find IDs. " +
          "In dual mode, IDs are prefixed with layer (e.g. 'project:42', 'global:7')."
        ),
    },
    async ({ factIds }) => {
      const results: string[] = [];
      const dual = isDualBackend(db);

      for (const id of factIds) {
        try {
          const parsed = parseFactId(id, dual);
          if ("error" in parsed) {
            results.push(`${id}: error — ${parsed.error}`);
            continue;
          }

          const target = parsed.layer && dual
            ? db.getLayerBackend(parsed.layer)
            : db;

          // Cascade: find facts that have superseded_by pointing to this fact
          let clearedCount = 0;
          if (target.findDependentFacts && target.clearSupersededBy) {
            try {
              const dependents = await target.findDependentFacts(parsed.numericId);
              if (dependents.length > 0) {
                clearedCount = await target.clearSupersededBy(dependents);
              }
            } catch (err) {
              // Log cascade error but continue with deletion
              console.error(
                "[claude-memory] WARNING: cascade cleanup failed:",
                err instanceof Error ? err.message : String(err)
              );
            }
          }

          const deleted = await target.deleteFact(parsed.numericId);
          if (deleted) {
            const cascadeNote = clearedCount > 0
              ? ` (cleared superseded_by on ${clearedCount} dependent fact${clearedCount > 1 ? "s" : ""})`
              : "";
            results.push(`${id}: deleted${cascadeNote}`);
          } else {
            results.push(`${id}: not found`);
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          results.push(`${id}: error — ${msg}`);
        }
      }

      return {
        content: [{ type: "text" as const, text: results.join("\n") }],
      };
    }
  );
}
