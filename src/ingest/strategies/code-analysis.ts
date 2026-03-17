/**
 * Code analysis extraction strategy.
 *
 * Processes source code files (*.kt, *.java, *.go, *.ts, *.py, *.rs, etc.)
 * in batches via Claude CLI. Focus: public APIs, class hierarchies, dependencies.
 * Auto-context: README + build file from the same module.
 */

import { readFileSync, existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { spawnClaude } from "../../claude.js";
import type { Config } from "../../config.js";
import type { ExtractionStrategy, ExtractedFact } from "./types.js";

const EXTRACTION_PROMPT = `You are a code analysis system. Extract structured facts from the following source code files.

For each fact, output a JSON object with:
- subject: The main entity (class, function, service, module)
- predicate: The relationship (e.g. "has_method", "extends", "implements", "depends_on", "exposes_api", "handles_error", "uses_pattern")
- object: The related entity or value
- fact: Full human-readable description of the fact
- context: Relevant code snippet
- source: The file path this fact came from

Focus on:
- Public APIs and method signatures
- Class hierarchies and inheritance
- Dependencies and imports (external libraries, internal modules)
- Error handling patterns
- Integration points (HTTP endpoints, gRPC services, message handlers)
- Design patterns used

Return a JSON array of facts: [{ subject, predicate, object, fact, context, source }, ...]

`;

/** Look for README.md or build files in the same directory or parent */
function findAutoContext(files: string[]): string {
  if (files.length === 0) return "";

  const firstFile = files[0]!;
  const dir = dirname(firstFile);
  const contextParts: string[] = [];

  // Check for README
  for (const name of ["README.md", "readme.md", "README"]) {
    const readmePath = join(dir, name);
    if (existsSync(readmePath)) {
      try {
        const content = readFileSync(readmePath, "utf-8").slice(0, 2000);
        contextParts.push(`--- README (${readmePath}) ---\n${content}`);
      } catch {
        // ignore
      }
      break;
    }
  }

  // Check for build files
  for (const name of [
    "package.json",
    "build.gradle.kts",
    "pom.xml",
    "go.mod",
    "Cargo.toml",
    "pyproject.toml",
  ]) {
    const buildPath = join(dir, name);
    if (existsSync(buildPath)) {
      try {
        const content = readFileSync(buildPath, "utf-8").slice(0, 2000);
        contextParts.push(`--- BUILD FILE (${buildPath}) ---\n${content}`);
      } catch {
        // ignore
      }
      break;
    }
  }

  return contextParts.join("\n\n");
}

export const codeAnalysisStrategy: ExtractionStrategy = {
  name: "code-analysis",

  async extract(
    files: string[],
    context: string,
    config: Config,
  ): Promise<ExtractedFact[]> {
    const batchSize = config.ingest?.batchSize ?? 5;
    const model = config.ingest?.model ?? "sonnet";
    const results: ExtractedFact[] = [];

    const autoContext = findAutoContext(files);

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

      let fullPrompt = EXTRACTION_PROMPT;
      if (context) {
        fullPrompt += `Project context: ${context}\n\n`;
      }
      if (autoContext) {
        fullPrompt += `Module context:\n${autoContext}\n\n`;
      }
      fullPrompt += `Source files:\n${fileContents}`;

      try {
        const facts = await spawnClaude<ExtractedFact[]>({
          prompt: fullPrompt,
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
          `[code-analysis] Batch extraction failed for files ${batch.map((f) => basename(f)).join(", ")}: ${err instanceof Error ? err.message : err}`,
        );
      }
    }

    return results;
  },
};
