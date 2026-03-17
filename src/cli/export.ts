import { createWriteStream } from "node:fs";
import { Writable } from "node:stream";
import type { QdrantBackend, QdrantScrollPoint } from "../qdrant.js";

/**
 * JSONL export record — fact data without embedding.
 */
export interface ExportRecord {
  subject: string;
  predicate: string;
  object: string;
  fact: string;
  context: string;
  source: string;
  created_at: string;
}

/**
 * Check if a source string matches a pattern.
 * Supports exact match and prefix match with trailing `*`.
 * Example: `"platform-lib:*"` matches `"platform-lib:changelog"`.
 */
export function matchSourcePattern(source: string, pattern: string): boolean {
  if (pattern.endsWith("*")) {
    const prefix = pattern.slice(0, -1);
    return source.startsWith(prefix);
  }
  return source === pattern;
}

/**
 * Serialize a Qdrant scroll point to an export JSON line (no embedding).
 */
export function serializeFactToJsonl(point: QdrantScrollPoint): string {
  const record: ExportRecord = {
    subject: point.payload.subject,
    predicate: point.payload.predicate,
    object: point.payload.object,
    fact: point.payload.fact,
    context: point.payload.context,
    source: point.payload.source,
    created_at: point.payload.created_at,
  };
  return JSON.stringify(record);
}

export interface ExportOptions {
  source?: string;
  output?: string;
  includeOutdated?: boolean;
}

/**
 * Run the export command: scroll facts from Qdrant and write JSONL.
 */
export async function runExport(
  qdrant: QdrantBackend,
  options: ExportOptions,
): Promise<{ exported: number }> {
  // Scroll all facts (with optional source filter at Qdrant level)
  const filter = options.source && !options.source.includes("*")
    ? { source: options.source }
    : undefined;

  const points = await qdrant.scrollFacts(filter);

  // Client-side source prefix filtering (for wildcard patterns)
  let filtered = points;
  if (options.source && options.source.includes("*")) {
    filtered = points.filter((p) => matchSourcePattern(p.payload.source, options.source!));
  }

  // Note: superseded_by filtering is a v3 concept.
  // Currently we export all facts. When superseded_by is added to the schema,
  // the --include-outdated flag will control whether superseded facts are included.
  // For now, all facts are "active" (no superseded_by field exists yet).

  // Choose output: file or stdout
  let output: Writable;
  let closeOutput = false;
  if (options.output) {
    output = createWriteStream(options.output, { encoding: "utf-8" });
    closeOutput = true;
  } else {
    output = process.stdout;
  }

  let exported = 0;

  for (const point of filtered) {
    const line = serializeFactToJsonl(point);
    output.write(line + "\n");
    exported++;
  }

  if (closeOutput) {
    await new Promise<void>((resolve, reject) => {
      output.end(() => resolve());
      output.on("error", reject);
    });
  }

  if (options.output) {
    console.error(`Exported ${exported} facts to ${options.output}`);
  }

  return { exported };
}
