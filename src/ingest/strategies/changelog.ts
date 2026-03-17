/**
 * Changelog extraction strategy.
 *
 * Processes CHANGELOG.md and release notes via Claude CLI.
 * Extracts facts with specialized predicates:
 * - breaking_change@{version}
 * - deprecated@{version}
 * - new_api@{version}
 * - migration_step
 * - behavioral_change@{version}
 */

import { readFileSync } from "node:fs";
import { basename } from "node:path";

import { spawnClaude } from "../../claude.js";
import type { Config } from "../../config.js";
import type { ExtractionStrategy, ExtractedFact } from "./types.js";

const EXTRACTION_PROMPT = `You are a changelog analysis system. Extract structured facts from the following changelog/release notes.

For each fact, output a JSON object with:
- subject: The library/service/API name
- predicate: One of these specialized predicates:
  * "breaking_change@{version}" - Breaking changes that require action
  * "deprecated@{version}" - Deprecated APIs/features
  * "new_api@{version}" - New capabilities added
  * "migration_step" - Actionable migration instructions
  * "behavioral_change@{version}" - Same API, different behavior
  * "fixed@{version}" - Bug fixes
- object: What was changed/added/removed
- fact: Full human-readable description of the change
- context: Relevant excerpt from the changelog
- source: The file path
- version: The version number this change applies to

Focus on:
- Breaking changes (highest priority)
- Deprecations and removals
- New APIs and features
- Migration steps between versions
- Behavioral changes

Return a JSON array of facts: [{ subject, predicate, object, fact, context, source, version }, ...]

Changelog:
`;

export const changelogStrategy: ExtractionStrategy = {
  name: "changelog",

  async extract(
    files: string[],
    context: string,
    config: Config,
  ): Promise<ExtractedFact[]> {
    const model = config.ingest?.model ?? "sonnet";
    const results: ExtractedFact[] = [];

    for (const file of files) {
      try {
        const content = readFileSync(file, "utf-8");
        const prompt = `${EXTRACTION_PROMPT}\n${context ? `Project context: ${context}\n\n` : ""}--- FILE: ${basename(file)} (${file}) ---\n${content}`;

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
                source: fact.source ?? file,
                version: fact.version,
              });
            }
          }
        }
      } catch (err) {
        console.error(
          `[changelog] Extraction failed for ${basename(file)}: ${err instanceof Error ? err.message : err}`,
        );
      }
    }

    return results;
  },
};
