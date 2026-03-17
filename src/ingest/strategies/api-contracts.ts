/**
 * API contracts extraction strategy.
 *
 * - OpenAPI (YAML/JSON): deterministic parsing using built-in JSON/YAML parsing
 *   Extracts endpoints, schemas, auth requirements, error codes.
 * - Proto, GraphQL: Claude CLI extraction.
 */

import { readFileSync } from "node:fs";
import { basename, extname } from "node:path";

import { spawnClaude } from "../../claude.js";
import type { Config } from "../../config.js";
import type { ExtractionStrategy, ExtractedFact } from "./types.js";

// ── OpenAPI deterministic parser (built-in, no external deps) ─────────────

/**
 * Minimal YAML parser for OpenAPI specs.
 * Handles the common subset: mappings, sequences, scalars, multi-line strings.
 * For complex YAML, falls back to Claude CLI.
 */
function parseSimpleYaml(text: string): unknown {
  // Try JSON first (some .yaml files are actually JSON)
  try {
    return JSON.parse(text);
  } catch {
    // continue with YAML parsing
  }

  return parseYamlLines(text.split("\n"), 0, -1).value;
}

interface YamlParseResult {
  value: unknown;
  endLine: number;
}

function parseYamlLines(
  lines: string[],
  startLine: number,
  parentIndent: number,
): YamlParseResult {
  const result: Record<string, unknown> = {};
  let i = startLine;

  while (i < lines.length) {
    const line = lines[i]!;
    const trimmed = line.trimStart();

    // Skip empty lines and comments
    if (!trimmed || trimmed.startsWith("#")) {
      i++;
      continue;
    }

    const indent = line.length - line.trimStart().length;

    // If we've de-indented past our level, we're done with this block
    if (indent <= parentIndent && i > startLine) {
      return { value: result, endLine: i };
    }

    // Check for sequence item
    if (trimmed.startsWith("- ")) {
      // This is a sequence -- collect all items at this indent
      const arr: unknown[] = [];
      while (i < lines.length) {
        const sLine = lines[i]!;
        const sTrimmed = sLine.trimStart();
        const sIndent = sLine.length - sLine.trimStart().length;

        if (!sTrimmed || sTrimmed.startsWith("#")) {
          i++;
          continue;
        }
        if (sIndent < indent) break;
        if (sIndent === indent && sTrimmed.startsWith("- ")) {
          arr.push(parseYamlScalar(sTrimmed.slice(2).trim()));
          i++;
        } else {
          i++;
        }
      }
      return { value: arr, endLine: i };
    }

    // Key-value pair
    const colonIdx = trimmed.indexOf(":");
    if (colonIdx > 0) {
      const key = trimmed.slice(0, colonIdx).trim();
      const valueStr = trimmed.slice(colonIdx + 1).trim();

      if (valueStr) {
        // Inline value
        result[key] = parseYamlScalar(valueStr);
        i++;
      } else {
        // Nested block -- check next non-empty line's indent
        let nextLine = i + 1;
        while (nextLine < lines.length) {
          const nl = lines[nextLine]!.trimStart();
          if (nl && !nl.startsWith("#")) break;
          nextLine++;
        }

        if (nextLine < lines.length) {
          const nextIndent =
            lines[nextLine]!.length - lines[nextLine]!.trimStart().length;
          if (nextIndent > indent) {
            const nested = parseYamlLines(lines, nextLine, indent);
            result[key] = nested.value;
            i = nested.endLine;
          } else {
            result[key] = null;
            i++;
          }
        } else {
          result[key] = null;
          i++;
        }
      }
    } else {
      i++;
    }
  }

  return { value: result, endLine: i };
}

function parseYamlScalar(s: string): string | number | boolean | null {
  if (!s) return null;
  // Remove quotes
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    return s.slice(1, -1);
  }
  if (s === "true") return true;
  if (s === "false") return false;
  if (s === "null" || s === "~") return null;
  const num = Number(s);
  if (!isNaN(num) && s.length > 0) return num;
  return s;
}

/**
 * Extract facts from an OpenAPI spec deterministically.
 */
export function extractOpenApiFacts(
  filePath: string,
  content: string,
): ExtractedFact[] {
  let spec: Record<string, unknown>;
  try {
    spec = parseSimpleYaml(content) as Record<string, unknown>;
  } catch {
    return [];
  }

  if (!spec || typeof spec !== "object") return [];

  const facts: ExtractedFact[] = [];

  // Detect API name and version
  const info = spec["info"] as Record<string, unknown> | undefined;
  const apiTitle =
    (info?.["title"] as string) ?? basename(filePath, extname(filePath));
  const apiVersion = (info?.["version"] as string) ?? undefined;

  // Extract endpoints from paths
  const paths = spec["paths"] as Record<string, unknown> | undefined;
  if (paths && typeof paths === "object") {
    for (const [path, methods] of Object.entries(paths)) {
      if (!methods || typeof methods !== "object") continue;

      for (const [method, operation] of Object.entries(
        methods as Record<string, unknown>,
      )) {
        // Skip non-HTTP methods (like parameters, $ref)
        if (
          !["get", "post", "put", "delete", "patch", "head", "options"].includes(
            method.toLowerCase(),
          )
        ) {
          continue;
        }

        const op = operation as Record<string, unknown> | undefined;
        const summary = (op?.["summary"] as string) ?? "";
        const operationId = (op?.["operationId"] as string) ?? "";
        const httpMethod = method.toUpperCase();

        // Endpoint fact
        facts.push({
          subject: apiTitle,
          predicate: "has_endpoint",
          object: `${httpMethod} ${path}`,
          fact: `${apiTitle} exposes endpoint ${httpMethod} ${path}${summary ? `: ${summary}` : ""}`,
          context: operationId ? `operationId: ${operationId}` : "",
          source: filePath,
          version: apiVersion,
        });

        // Request body schema
        const requestBody = op?.["requestBody"] as
          | Record<string, unknown>
          | undefined;
        if (requestBody) {
          const contentTypes = requestBody["content"] as
            | Record<string, unknown>
            | undefined;
          if (contentTypes) {
            const jsonContent = (contentTypes["application/json"] ??
              Object.values(contentTypes)[0]) as
              | Record<string, unknown>
              | undefined;
            const schema = jsonContent?.["schema"] as
              | Record<string, unknown>
              | undefined;
            if (schema) {
              const schemaRef = (schema["$ref"] as string) ?? "";
              const schemaName = schemaRef
                ? schemaRef.split("/").pop() ?? "RequestBody"
                : "RequestBody";
              facts.push({
                subject: `${httpMethod} ${path}`,
                predicate: "accepts",
                object: schemaName,
                fact: `${httpMethod} ${path} accepts ${schemaName}`,
                context: JSON.stringify(schema).slice(0, 500),
                source: filePath,
                version: apiVersion,
              });
            }
          }
        }

        // Response schemas
        const responses = op?.["responses"] as
          | Record<string, unknown>
          | undefined;
        if (responses) {
          for (const [statusCode, response] of Object.entries(responses)) {
            const resp = response as Record<string, unknown> | undefined;
            const description = (resp?.["description"] as string) ?? "";

            if (
              statusCode.startsWith("4") ||
              statusCode.startsWith("5")
            ) {
              facts.push({
                subject: `${httpMethod} ${path}`,
                predicate: "error",
                object: `${statusCode} ${description}`,
                fact: `${httpMethod} ${path} can return ${statusCode}: ${description}`,
                context: "",
                source: filePath,
                version: apiVersion,
              });
            } else if (
              statusCode.startsWith("2")
            ) {
              const respContent = resp?.["content"] as
                | Record<string, unknown>
                | undefined;
              if (respContent) {
                const jsonResp = (respContent["application/json"] ??
                  Object.values(respContent)[0]) as
                  | Record<string, unknown>
                  | undefined;
                const schema = jsonResp?.["schema"] as
                  | Record<string, unknown>
                  | undefined;
                if (schema) {
                  const schemaRef = (schema["$ref"] as string) ?? "";
                  const schemaName = schemaRef
                    ? schemaRef.split("/").pop() ?? "Response"
                    : "Response";
                  facts.push({
                    subject: `${httpMethod} ${path}`,
                    predicate: "returns",
                    object: schemaName,
                    fact: `${httpMethod} ${path} returns ${schemaName}`,
                    context: JSON.stringify(schema).slice(0, 500),
                    source: filePath,
                    version: apiVersion,
                  });
                }
              }
            }
          }
        }

        // Security requirements
        const security = (op?.["security"] ?? spec["security"]) as
          | Array<Record<string, unknown>>
          | undefined;
        if (Array.isArray(security) && security.length > 0) {
          const schemes = security
            .flatMap((s) => Object.keys(s))
            .filter(Boolean);
          if (schemes.length > 0) {
            facts.push({
              subject: `${httpMethod} ${path}`,
              predicate: "requires_auth",
              object: schemes.join(", "),
              fact: `${httpMethod} ${path} requires authentication: ${schemes.join(", ")}`,
              context: "",
              source: filePath,
              version: apiVersion,
            });
          }
        }

        // Tags
        const tags = op?.["tags"] as string[] | undefined;
        if (Array.isArray(tags) && tags.length > 0) {
          facts.push({
            subject: apiTitle,
            predicate: "tagged",
            object: tags.join(", "),
            fact: `${httpMethod} ${path} is tagged with: ${tags.join(", ")}`,
            context: "",
            source: filePath,
            version: apiVersion,
          });
        }
      }
    }
  }

  // Extract component schemas
  const components = spec["components"] as Record<string, unknown> | undefined;
  const schemas = components?.["schemas"] as
    | Record<string, unknown>
    | undefined;
  if (schemas && typeof schemas === "object") {
    for (const [schemaName, schema] of Object.entries(schemas)) {
      const s = schema as Record<string, unknown> | undefined;
      if (!s) continue;

      const properties = s["properties"] as
        | Record<string, unknown>
        | undefined;
      const required = (s["required"] as string[]) ?? [];
      const propNames = properties ? Object.keys(properties) : [];

      if (propNames.length > 0) {
        facts.push({
          subject: apiTitle,
          predicate: "defines_schema",
          object: schemaName,
          fact: `${apiTitle} defines schema ${schemaName} with fields: ${propNames.join(", ")}${required.length > 0 ? ` (required: ${required.join(", ")})` : ""}`,
          context: JSON.stringify(schema).slice(0, 500),
          source: filePath,
          version: apiVersion,
        });
      }
    }
  }

  // Extract security schemes
  const securitySchemes = components?.["securitySchemes"] as
    | Record<string, unknown>
    | undefined;
  if (securitySchemes && typeof securitySchemes === "object") {
    for (const [schemeName, scheme] of Object.entries(securitySchemes)) {
      const s = scheme as Record<string, unknown> | undefined;
      const type = (s?.["type"] as string) ?? "unknown";
      const schemeType = (s?.["scheme"] as string) ?? "";

      facts.push({
        subject: apiTitle,
        predicate: "has_auth_scheme",
        object: schemeName,
        fact: `${apiTitle} uses ${type}${schemeType ? ` (${schemeType})` : ""} authentication: ${schemeName}`,
        context: "",
        source: filePath,
        version: apiVersion,
      });
    }
  }

  return facts;
}

// ── Claude CLI extraction prompt for Proto/GraphQL ────────────────────────

const PROTO_GRAPHQL_PROMPT = `You are a knowledge extraction system. Extract structured facts from the following API contract files (Proto/GraphQL).

For each fact, output a JSON object with:
- subject: The service or type name
- predicate: The relationship (e.g. "has_rpc", "has_field", "defines_type", "depends_on")
- object: The related entity or value
- fact: Full human-readable description
- context: Relevant code snippet
- source: The file path

Return a JSON array of facts: [{ subject, predicate, object, fact, context, source }, ...]

Files:
`;

export const apiContractsStrategy: ExtractionStrategy = {
  name: "api-contracts",

  async extract(
    files: string[],
    context: string,
    config: Config,
  ): Promise<ExtractedFact[]> {
    const model = config.ingest?.model ?? "sonnet";
    const results: ExtractedFact[] = [];

    const openApiFiles: string[] = [];
    const claudeFiles: string[] = [];

    // Classify files
    for (const file of files) {
      const ext = extname(file).toLowerCase();
      if (ext === ".yaml" || ext === ".yml" || ext === ".json") {
        openApiFiles.push(file);
      } else {
        claudeFiles.push(file);
      }
    }

    // Deterministic OpenAPI extraction
    for (const file of openApiFiles) {
      try {
        const content = readFileSync(file, "utf-8");
        const facts = extractOpenApiFacts(file, content);
        results.push(...facts);
      } catch (err) {
        console.error(
          `[api-contracts] OpenAPI parse failed for ${basename(file)}: ${err instanceof Error ? err.message : err}`,
        );
      }
    }

    // Claude CLI for Proto/GraphQL
    if (claudeFiles.length > 0) {
      const fileContents = claudeFiles
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

      if (fileContents.trim()) {
        const prompt = `${PROTO_GRAPHQL_PROMPT}\n${context ? `Project context: ${context}\n\n` : ""}${fileContents}`;

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
            `[api-contracts] Claude extraction failed for proto/graphql files: ${err instanceof Error ? err.message : err}`,
          );
        }
      }
    }

    return results;
  },
};
