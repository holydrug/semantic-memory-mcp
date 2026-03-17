/**
 * Documentation extraction strategy.
 *
 * Processes *.md, *.rst, *.adoc, *.txt, *.html files in batches
 * via Claude CLI. Focus: API descriptions, config, behavior contracts.
 * Preserves code examples as context.
 */

import { readFileSync } from "node:fs";
import { basename } from "node:path";

import { spawnClaude } from "../../claude.js";
import type { Config } from "../../config.js";
import type { ExtractionStrategy, ExtractedFact } from "./types.js";

const EXTRACTION_PROMPT = `You are a knowledge extraction system. Extract structured facts from the following documentation files.

For each fact, output a JSON object with:
- subject: The main entity (e.g. service name, API, config key)
- predicate: The relationship (e.g. "uses", "depends_on", "has_config", "has_behavior", "requires")
- object: The related entity or value
- fact: Full human-readable description of the fact
- context: Code example or relevant snippet from the source (if any)
- source: The file path this fact came from

Focus on:
- API descriptions and endpoints
- Configuration options and their effects
- Behavior contracts and invariants
- Dependencies and integration points
- Architecture decisions

Return a JSON array of facts: [{ subject, predicate, object, fact, context, source }, ...]

Documentation files:
`;

export const documentationStrategy: ExtractionStrategy = {
  name: "documentation",

  async extract(
    files: string[],
    context: string,
    config: Config,
  ): Promise<ExtractedFact[]> {
    const batchSize = config.ingest?.batchSize ?? 5;
    const model = config.ingest?.model ?? "sonnet";
    const results: ExtractedFact[] = [];

    // Process files in batches
    for (let i = 0; i < files.length; i += batchSize) {
      const batch = files.slice(i, i + batchSize);
      const fileContents = batch
        .map((f) => {
          try {
            const content = readFileSync(f, "utf-8");
            return `--- FILE: ${basename(f)} (${f}) ---\n${content}\n`;
          } catch {
            return "";
          }
        })
        .filter(Boolean)
        .join("\n");

      if (!fileContents.trim()) continue;

      const prompt = `${EXTRACTION_PROMPT}\n${context ? `Project context: ${context}\n\n` : ""}${fileContents}`;

      try {
        const facts = await spawnClaude<ExtractedFact[]>({
          prompt,
          model,
          maxTurns: 1,
          timeout: 60_000,
        });

        if (Array.isArray(facts)) {
          for (const fact of facts) {
            if (fact.subject && fact.predicate && fact.object && fact.fact) {
              results.push({
                subject: fact.subject,
                predicate: fact.predicate,
                object: fact.object,
                fact: fact.fact,
                context: fact.context ?? "",
                source: fact.source ?? batch[0] ?? "",
              });
            }
          }
        }
      } catch (err) {
        console.error(
          `[documentation] Batch extraction failed for files ${batch.map((f) => basename(f)).join(", ")}: ${err instanceof Error ? err.message : err}`,
        );
      }
    }

    return results;
  },
};
