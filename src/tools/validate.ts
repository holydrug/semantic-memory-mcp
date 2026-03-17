import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { StorageBackend } from "../types.js";
import type { Config } from "../config.js";
import { buildDescription } from "../triggers.js";
import { spawnClaude, ClaudeCliError } from "../claude.js";

interface ValidationDecision {
  id: number;
  verdict: "VALID" | "STALE" | "UNKNOWN";
  reason: string;
}

interface ClaudeValidationResponse {
  decisions: ValidationDecision[];
}

export interface ValidateResult {
  reviewed: number;
  confirmed: number;
  stale: number;
  unknown: number;
  details: Array<{ id: string; verdict: string; reason: string }>;
}

export function registerValidateTool(
  server: McpServer,
  db: StorageBackend,
  config: Config,
): void {
  server.tool(
    "memory_validate",
    buildDescription("validate", undefined),
    {
      subject: z
        .string()
        .optional()
        .describe("Optional — validate only facts about this entity"),
      source: z
        .string()
        .optional()
        .describe("Optional — validate only facts from this source"),
      max_age_days: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("Only validate facts not validated in this many days (default: 30)"),
    },
    async ({ subject, source, max_age_days }) => {
      // Check if validation is enabled
      if (config.validation.mode === "off") {
        return {
          content: [{
            type: "text" as const,
            text: "Validation is disabled (validation.mode = 'off'). Enable it in config to use memory_validate.",
          }],
        };
      }

      // Check if backend supports validation queries
      if (!db.queryFactsForValidation || !db.updateFactValidation) {
        return {
          content: [{
            type: "text" as const,
            text: "Backend does not support validation queries. Ensure Neo4j backend is configured.",
          }],
        };
      }

      const maxAgeDays = max_age_days ?? 30;
      const batchSize = config.validation.sweepBatchSize;

      // Query facts needing validation
      let facts;
      try {
        facts = await db.queryFactsForValidation({
          subject,
          source,
          maxAgeDays,
          limit: batchSize,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{
            type: "text" as const,
            text: `Error querying facts for validation: ${msg}`,
          }],
          isError: true,
        };
      }

      if (facts.length === 0) {
        return {
          content: [{
            type: "text" as const,
            text: "No facts require validation. All facts are up to date.",
          }],
        };
      }

      // Build prompt for Claude
      const factsText = facts
        .map(
          (f) =>
            `[${f.factId}] ${f.subject} -[${f.predicate}]-> ${f.object}: ${f.content}`,
        )
        .join("\n");

      const prompt = `Review these ${facts.length} facts from a knowledge base.
For each, decide:
  VALID — still likely correct, no reason to doubt
  STALE — likely outdated (technology version changed, API deprecated, etc.)
  UNKNOWN — can't determine without more context

Facts:
${factsText}

Respond as JSON: { "decisions": [{ "id": <number>, "verdict": "VALID"|"STALE"|"UNKNOWN", "reason": "<brief reason>" }] }`;

      let response: ClaudeValidationResponse;
      try {
        response = await spawnClaude<ClaudeValidationResponse>({
          prompt,
          model: config.validation.model,
          maxTurns: 1,
          timeout: 120_000,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const isClaudeError = err instanceof ClaudeCliError;
        return {
          content: [{
            type: "text" as const,
            text: `Validation failed: ${isClaudeError ? "Claude CLI error" : "unexpected error"} — ${msg}`,
          }],
          isError: true,
        };
      }

      // Apply decisions
      const result: ValidateResult = {
        reviewed: 0,
        confirmed: 0,
        stale: 0,
        unknown: 0,
        details: [],
      };

      const now = new Date().toISOString();
      const factIdSet = new Set(facts.map((f) => f.factId));

      if (response.decisions && Array.isArray(response.decisions)) {
        for (const d of response.decisions) {
          // Skip decisions for IDs not in our batch
          if (!factIdSet.has(d.id)) continue;

          result.reviewed++;

          try {
            if (d.verdict === "VALID") {
              await db.updateFactValidation!(d.id, {
                confidence: 1.0,
                lastValidated: now,
              });
              result.confirmed++;
            } else if (d.verdict === "STALE") {
              await db.updateFactValidation!(d.id, {
                confidence: 0.5,
                lastValidated: now,
              });
              result.stale++;
            } else {
              // UNKNOWN — reset timer, keep confidence
              await db.updateFactValidation!(d.id, {
                lastValidated: now,
              });
              result.unknown++;
            }

            result.details.push({
              id: String(d.id),
              verdict: d.verdict,
              reason: d.reason || "",
            });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            result.details.push({
              id: String(d.id),
              verdict: "ERROR",
              reason: `Failed to update: ${msg}`,
            });
          }
        }
      }

      // Format response
      const lines = [
        `Validation complete:`,
        `  Reviewed: ${result.reviewed}`,
        `  Confirmed (VALID): ${result.confirmed}`,
        `  Stale: ${result.stale}`,
        `  Unknown: ${result.unknown}`,
        "",
        "Details:",
      ];

      for (const d of result.details) {
        lines.push(`  [${d.id}] ${d.verdict}: ${d.reason}`);
      }

      return {
        content: [{
          type: "text" as const,
          text: lines.join("\n"),
        }],
      };
    },
  );
}
