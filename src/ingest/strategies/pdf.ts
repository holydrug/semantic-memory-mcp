/**
 * PDF extraction strategy.
 *
 * Processes *.pdf files one at a time via Claude CLI (vision).
 * No pdf-parse dependency needed -- Sonnet reads PDFs natively.
 */

import { basename } from "node:path";

import { spawnClaude } from "../../claude.js";
import type { Config } from "../../config.js";
import type { ExtractionStrategy, ExtractedFact } from "./types.js";

const EXTRACTION_PROMPT = `You are a knowledge extraction system. Read the following PDF document and extract structured facts.

For each fact, output a JSON object with:
- subject: The main entity (e.g. service name, API, component)
- predicate: The relationship (e.g. "has_architecture", "follows_pattern", "has_requirement", "defines")
- object: The related entity or value
- fact: Full human-readable description of the fact
- context: Relevant excerpt or section reference
- source: The file path

Focus on:
- Architecture decisions and rationale
- API specifications and contracts
- Flow descriptions and sequences
- Requirements and constraints
- Migration steps and breaking changes

Return a JSON array of facts: [{ subject, predicate, object, fact, context, source }, ...]

PDF file path: `;

export const pdfStrategy: ExtractionStrategy = {
  name: "pdf",

  async extract(
    files: string[],
    context: string,
    config: Config,
  ): Promise<ExtractedFact[]> {
    const model = config.ingest?.model ?? "sonnet";
    const results: ExtractedFact[] = [];

    // One Claude CLI call per PDF (vision reads the file natively)
    for (const file of files) {
      const prompt = `${EXTRACTION_PROMPT}${file}${context ? `\n\nProject context: ${context}` : ""}`;

      try {
        const facts = await spawnClaude<ExtractedFact[]>({
          prompt,
          model,
          maxTurns: 1,
          timeout: 120_000, // PDFs may take longer
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
                source: fact.source ?? file,
              });
            }
          }
        }
      } catch (err) {
        console.error(
          `[pdf] Extraction failed for ${basename(file)}: ${err instanceof Error ? err.message : err}`,
        );
      }
    }

    return results;
  },
};
