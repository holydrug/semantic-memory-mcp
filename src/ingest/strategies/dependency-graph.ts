/**
 * Dependency graph extraction strategy.
 *
 * - package.json -> deterministic JSON parse -> dependency facts
 * - go.mod -> line-based parse -> dependency facts
 * - build.gradle.kts, pom.xml, etc. -> Claude CLI
 * - Gradle: libs.versions.toml passed as context
 */

import { readFileSync, existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { spawnClaude } from "../../claude.js";
import type { Config } from "../../config.js";
import type { ExtractionStrategy, ExtractedFact } from "./types.js";

// ── Deterministic parsers ─────────────────────────────────────────────────

/**
 * Extract dependency facts from package.json.
 */
export function extractPackageJsonFacts(
  filePath: string,
  content: string,
): ExtractedFact[] {
  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(content) as Record<string, unknown>;
  } catch {
    return [];
  }

  const facts: ExtractedFact[] = [];
  const name = (pkg["name"] as string) ?? basename(dirname(filePath));
  const version = (pkg["version"] as string) ?? undefined;

  // dependencies
  const deps = pkg["dependencies"] as Record<string, string> | undefined;
  if (deps && typeof deps === "object") {
    for (const [dep, ver] of Object.entries(deps)) {
      facts.push({
        subject: name,
        predicate: "depends_on",
        object: `${dep}@${ver}`,
        fact: `${name} depends on ${dep} (version: ${ver})`,
        context: `"dependencies": { "${dep}": "${ver}" }`,
        source: filePath,
        version,
      });
    }
  }

  // devDependencies
  const devDeps = pkg["devDependencies"] as Record<string, string> | undefined;
  if (devDeps && typeof devDeps === "object") {
    for (const [dep, ver] of Object.entries(devDeps)) {
      facts.push({
        subject: name,
        predicate: "dev_depends_on",
        object: `${dep}@${ver}`,
        fact: `${name} has dev dependency on ${dep} (version: ${ver})`,
        context: `"devDependencies": { "${dep}": "${ver}" }`,
        source: filePath,
        version,
      });
    }
  }

  // peerDependencies
  const peerDeps = pkg["peerDependencies"] as
    | Record<string, string>
    | undefined;
  if (peerDeps && typeof peerDeps === "object") {
    for (const [dep, ver] of Object.entries(peerDeps)) {
      facts.push({
        subject: name,
        predicate: "peer_depends_on",
        object: `${dep}@${ver}`,
        fact: `${name} has peer dependency on ${dep} (version: ${ver})`,
        context: `"peerDependencies": { "${dep}": "${ver}" }`,
        source: filePath,
        version,
      });
    }
  }

  // engines
  const engines = pkg["engines"] as Record<string, string> | undefined;
  if (engines && typeof engines === "object") {
    for (const [engine, ver] of Object.entries(engines)) {
      facts.push({
        subject: name,
        predicate: "requires_engine",
        object: `${engine}@${ver}`,
        fact: `${name} requires ${engine} ${ver}`,
        context: `"engines": { "${engine}": "${ver}" }`,
        source: filePath,
        version,
      });
    }
  }

  return facts;
}

/**
 * Extract dependency facts from go.mod (line-based parsing).
 */
export function extractGoModFacts(
  filePath: string,
  content: string,
): ExtractedFact[] {
  const facts: ExtractedFact[] = [];
  const lines = content.split("\n");

  let moduleName = "";
  let goVersion: string | undefined;
  let inRequire = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();

    // Module name
    if (line.startsWith("module ")) {
      moduleName = line.slice(7).trim();
      continue;
    }

    // Go version
    if (line.startsWith("go ")) {
      goVersion = line.slice(3).trim();
      facts.push({
        subject: moduleName || basename(dirname(filePath)),
        predicate: "requires_engine",
        object: `go@${goVersion}`,
        fact: `${moduleName || basename(dirname(filePath))} requires Go ${goVersion}`,
        context: line,
        source: filePath,
      });
      continue;
    }

    // require block
    if (line === "require (") {
      inRequire = true;
      continue;
    }
    if (line === ")") {
      inRequire = false;
      continue;
    }

    // Single-line require
    if (line.startsWith("require ") && !line.includes("(")) {
      const parts = line.slice(8).trim().split(/\s+/);
      if (parts.length >= 2) {
        const dep = parts[0]!;
        const ver = parts[1]!;
        facts.push({
          subject: moduleName || basename(dirname(filePath)),
          predicate: "depends_on",
          object: `${dep}@${ver}`,
          fact: `${moduleName || basename(dirname(filePath))} depends on ${dep} (version: ${ver})`,
          context: line,
          source: filePath,
          version: goVersion,
        });
      }
      continue;
    }

    // Inside require block
    if (inRequire && line && !line.startsWith("//")) {
      const parts = line.split(/\s+/);
      if (parts.length >= 2) {
        const dep = parts[0]!;
        const ver = parts[1]!;
        // Skip indirect dependencies
        const isIndirect = line.includes("// indirect");
        facts.push({
          subject: moduleName || basename(dirname(filePath)),
          predicate: isIndirect ? "indirect_depends_on" : "depends_on",
          object: `${dep}@${ver}`,
          fact: `${moduleName || basename(dirname(filePath))} ${isIndirect ? "indirectly " : ""}depends on ${dep} (version: ${ver})`,
          context: line,
          source: filePath,
          version: goVersion,
        });
      }
    }
  }

  return facts;
}

// ── Claude CLI prompt for Gradle/Maven/etc. ────────────────────────────────

const BUILD_FILE_PROMPT = `You are a build system analyst. Extract dependency facts from the following build file(s).

For each fact, output a JSON object with:
- subject: The project/module name
- predicate: The relationship ("depends_on", "uses_plugin", "uses_api_version", "has_config")
- object: The dependency or value (include version if available)
- fact: Full human-readable description
- context: Relevant code snippet
- source: The file path

Pay attention to:
- Direct dependencies with versions
- Plugin usage
- Version catalog references (libs.xxx.yyy)
- API version pinning (e.g. implementation("group:artifact:version"))
- Multi-module project structure

Return a JSON array of facts: [{ subject, predicate, object, fact, context, source }, ...]

Build files:
`;

export const dependencyGraphStrategy: ExtractionStrategy = {
  name: "dependency-graph",

  async extract(
    files: string[],
    context: string,
    config: Config,
  ): Promise<ExtractedFact[]> {
    const model = config.ingest?.model ?? "sonnet";
    const results: ExtractedFact[] = [];

    const deterministicFiles: Array<{
      path: string;
      type: "package.json" | "go.mod";
    }> = [];
    const claudeFiles: string[] = [];

    // Classify files
    for (const file of files) {
      const base = basename(file);
      if (base === "package.json") {
        deterministicFiles.push({ path: file, type: "package.json" });
      } else if (base === "go.mod") {
        deterministicFiles.push({ path: file, type: "go.mod" });
      } else {
        claudeFiles.push(file);
      }
    }

    // Deterministic extraction
    for (const { path, type } of deterministicFiles) {
      try {
        const content = readFileSync(path, "utf-8");
        const facts =
          type === "package.json"
            ? extractPackageJsonFacts(path, content)
            : extractGoModFacts(path, content);
        results.push(...facts);
      } catch (err) {
        console.error(
          `[dependency-graph] Parse failed for ${basename(path)}: ${err instanceof Error ? err.message : err}`,
        );
      }
    }

    // Claude CLI for Gradle/Maven/etc.
    if (claudeFiles.length > 0) {
      const fileContents: string[] = [];

      for (const f of claudeFiles) {
        try {
          const content = readFileSync(f, "utf-8");
          fileContents.push(`--- FILE: ${basename(f)} (${f}) ---\n${content}\n`);

          // For Gradle: look for libs.versions.toml as context
          if (basename(f) === "build.gradle.kts") {
            const versionCatalog = join(
              dirname(f),
              "gradle",
              "libs.versions.toml",
            );
            if (existsSync(versionCatalog)) {
              try {
                const tomlContent = readFileSync(versionCatalog, "utf-8");
                fileContents.push(
                  `--- CONTEXT: libs.versions.toml ---\n${tomlContent}\n`,
                );
              } catch {
                // ignore
              }
            }
          }
        } catch {
          // ignore unreadable files
        }
      }

      if (fileContents.length > 0) {
        const prompt = `${BUILD_FILE_PROMPT}\n${context ? `Project context: ${context}\n\n` : ""}${fileContents.join("\n")}`;

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
                  source: fact.source ?? claudeFiles[0] ?? "",
                });
              }
            }
          }
        } catch (err) {
          console.error(
            `[dependency-graph] Claude extraction failed: ${err instanceof Error ? err.message : err}`,
          );
        }
      }
    }

    return results;
  },
};
