import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { StorageBackend } from "../types.js";
import type { Config } from "../config.js";
import { buildDescription } from "../triggers.js";

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
        lines.push(`  ${e.name} (${e.factCount} facts)`);
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
