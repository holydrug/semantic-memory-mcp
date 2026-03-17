import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { StorageBackend, EmbedFn } from "../types.js";
import { isDualBackend } from "../types.js";
import type { Config } from "../config.js";
import { buildDescription } from "../triggers.js";
import { classifyScope } from "../classify.js";
import { ClaudeCliError } from "../claude.js";
import {
  detectAndResolveConflicts,
  type ConflictSearchFn,
  type SupersedeFactFn,
  type ValidationResult,
} from "../validate.js";
import type { QdrantSearchResult } from "../qdrant.js";

export function registerStoreTool(
  server: McpServer,
  db: StorageBackend,
  embed: EmbedFn,
  config: Config
): void {
  server.tool(
    "memory_store",
    buildDescription("store", config.triggersStore),
    {
      subject: z
        .string()
        .describe("Subject entity in English (e.g. 'billing-service')"),
      predicate: z
        .string()
        .describe(
          "Relationship verb in English (e.g. 'uses', 'depends_on', 'has_pattern')"
        ),
      object: z
        .string()
        .describe("Object entity in English (e.g. 'PostgreSQL 16')"),
      fact: z.string().describe("Full fact description (any language)"),
      context: z.string().describe("Source context or snippet"),
      source: z
        .string()
        .optional()
        .describe("Source file path or URL (optional)"),
      version: z
        .string()
        .optional()
        .describe("Version tag for the fact (e.g. '0.75', '18.2', 'v3')"),
      force: z
        .boolean()
        .optional()
        .describe("Skip conflict validation and store regardless (default: false)"),
    },
    async ({ subject, predicate, object, fact, context, source, version, force }) => {
      const [subjectEmb, objectEmb, factEmb] = await Promise.all([
        embed(subject),
        embed(object),
        embed(fact),
      ]);

      // Auto-route to correct layer in dual mode
      const scope = isDualBackend(db) ? classifyScope(predicate) : null;
      const target = scope && isDualBackend(db) ? db.getLayerBackend(scope) : db;

      // Determine if validation should run
      const skipValidation = force === true || config.validation.mode === "off";

      let validation: ValidationResult | undefined;

      if (!skipValidation) {
        // Build search function for conflict detection
        // Uses the backend's searchFactsFiltered if available, otherwise skip validation
        const searchFn: ConflictSearchFn = async (
          embedding: number[],
          limit: number,
          filter?: { layer?: string },
        ): Promise<QdrantSearchResult[]> => {
          if (target.searchFactsFiltered) {
            const results = await target.searchFactsFiltered(
              new Float32Array(embedding),
              limit,
              {
                ...(filter?.layer ? {} : {}),
              },
            );
            return results.map((r) => ({
              id: parseInt(r.factId, 10),
              score: r.score,
              payload: {
                layer: r.sourceLayer ?? null,
                subject: r.subject,
                predicate: r.predicate,
                object: r.object,
                fact: r.fact,
                context: r.context,
                source: r.source,
                scope_candidate: null,
                created_at: r.createdAt ?? new Date().toISOString(),
              },
            }));
          }
          // Fallback: use regular search
          const results = await target.searchFacts(
            new Float32Array(embedding),
            limit,
          );
          return results.map((r) => ({
            id: parseInt(r.factId, 10),
            score: r.score,
            payload: {
              layer: r.sourceLayer ?? null,
              subject: r.subject,
              predicate: r.predicate,
              object: r.object,
              fact: r.fact,
              context: r.context,
              source: r.source,
              scope_candidate: null,
              created_at: r.createdAt ?? new Date().toISOString(),
            },
          }));
        };

        // Build supersede function
        const supersedeFn: SupersedeFactFn = async (
          _factId: number,
          _supersededBy: string,
          _reason: string,
        ): Promise<void> => {
          // In v3, this will update the fact in Neo4j + Qdrant with:
          //   valid_until = now, superseded_by = new_id, confidence = 0
          // For now, this is a no-op placeholder — the full supersession
          // marking requires the v3 schema fields (Step 03).
          // The validation result still tracks what was superseded.
        };

        try {
          validation = await detectAndResolveConflicts(
            {
              subject,
              predicate,
              object,
              fact,
              context,
              source: source ?? "",
              version,
              embedding: Array.from(factEmb),
            },
            config,
            searchFn,
            supersedeFn,
            scope,
          );

          // If duplicate — don't store, return info about existing fact
          if (validation.action === "DUPLICATE" && validation.existing) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify({
                    stored: false,
                    factId: validation.existing.id,
                    validation: {
                      action: "DUPLICATE",
                      existing: validation.existing,
                      reason: validation.reason,
                    },
                  }),
                },
              ],
            };
          }
        } catch (err) {
          if (err instanceof ClaudeCliError) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify({
                    stored: false,
                    error: `Validation failed: ${err.message}. Use force: true to skip validation.`,
                  }),
                },
              ],
              isError: true,
            };
          }
          throw err;
        }
      }

      // Store the fact
      const subjectId = await target.findOrCreateEntity(subject, subjectEmb);
      const objectId = await target.findOrCreateEntity(object, objectEmb);

      const factId = await target.storeFact({
        subjectId,
        predicate,
        objectId,
        content: fact,
        context,
        source: source ?? "",
        embedding: factEmb,
        scopeCandidate: scope,
      });

      const layerTag = scope ? ` [${scope}]` : "";

      // Build response with validation info
      if (force === true) {
        validation = { action: "FORCED" };
      }

      const response: Record<string, unknown> = {
        stored: true,
        factId: String(factId),
      };

      if (validation) {
        response.validation = {
          action: validation.action,
          ...(validation.superseded ? { superseded: validation.superseded } : {}),
          ...(validation.reason ? { reason: validation.reason } : {}),
        };
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(response),
          },
        ],
      };
    }
  );
}
