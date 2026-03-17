import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import type { StorageBackend, EmbedFn } from "../types.js";
import { isDualBackend } from "../types.js";
import { classifyScope } from "../classify.js";
import type { ExportRecord } from "./export.js";

/**
 * Parse a single JSONL line into an ExportRecord.
 * Returns null if the line is invalid or empty.
 */
export function parseJsonlLine(line: string): ExportRecord | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  try {
    const obj = JSON.parse(trimmed) as Record<string, unknown>;

    // Validate required fields
    if (
      typeof obj.subject !== "string" ||
      typeof obj.predicate !== "string" ||
      typeof obj.object !== "string" ||
      typeof obj.fact !== "string"
    ) {
      return null;
    }

    return {
      subject: obj.subject,
      predicate: obj.predicate,
      object: obj.object,
      fact: obj.fact as string,
      context: (obj.context as string) ?? "",
      source: (obj.source as string) ?? "",
      created_at: (obj.created_at as string) ?? new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

export interface ImportOptions {
  sourceOverride?: string;
}

export interface ImportStats {
  imported: number;
  duplicates: number;
  conflicts: number;
  errors: number;
  total: number;
}

/**
 * Render a simple progress bar.
 */
function renderProgress(current: number, total: number | null, stats: ImportStats): void {
  if (total && total > 0) {
    const pct = Math.min(1, current / total);
    const barLen = 20;
    const filled = Math.round(pct * barLen);
    const bar = "\u2588".repeat(filled) + "\u2591".repeat(barLen - filled);
    process.stderr.write(
      `\r  ${bar} ${current}/${total}` +
      `  Imported: ${stats.imported} | Duplicates: ${stats.duplicates} | Conflicts: ${stats.conflicts}`
    );
  } else {
    process.stderr.write(
      `\r  Processed: ${current}` +
      `  Imported: ${stats.imported} | Duplicates: ${stats.duplicates} | Conflicts: ${stats.conflicts}`
    );
  }
}

/**
 * Count lines in a file for progress reporting.
 */
async function countLines(filePath: string): Promise<number> {
  let count = 0;
  const rl = createInterface({
    input: createReadStream(filePath),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (line.trim()) count++;
  }
  return count;
}

/**
 * Run the import command: read JSONL, re-embed, and store each fact.
 */
export async function runImport(
  filePath: string,
  db: StorageBackend,
  embed: EmbedFn,
  options: ImportOptions,
): Promise<ImportStats> {
  console.error(`Importing ${filePath}...`);

  // Count lines first for progress
  const totalLines = await countLines(filePath);

  const stats: ImportStats = {
    imported: 0,
    duplicates: 0,
    conflicts: 0,
    errors: 0,
    total: totalLines,
  };

  const rl = createInterface({
    input: createReadStream(filePath),
    crlfDelay: Infinity,
  });

  let processed = 0;

  for await (const line of rl) {
    const record = parseJsonlLine(line);
    if (!record) {
      if (line.trim()) {
        stats.errors++;
        console.error(`\n  WARNING: Skipping invalid line: ${line.substring(0, 80)}...`);
      }
      continue;
    }

    processed++;

    // Apply source override
    const source = options.sourceOverride ?? record.source;

    try {
      // Generate embeddings
      const [subjectEmb, objectEmb, factEmb] = await Promise.all([
        embed(record.subject),
        embed(record.object),
        embed(record.fact),
      ]);

      // Auto-route to correct layer in dual mode
      const scope = isDualBackend(db) ? classifyScope(record.predicate) : null;
      const target = scope && isDualBackend(db) ? db.getLayerBackend(scope) : db;

      const subjectId = await target.findOrCreateEntity(record.subject, subjectEmb);
      const objectId = await target.findOrCreateEntity(record.object, objectEmb);

      await target.storeFact({
        subjectId,
        predicate: record.predicate,
        objectId,
        content: record.fact,
        context: record.context,
        source,
        embedding: factEmb,
        scopeCandidate: scope,
      });

      stats.imported++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      // Check for duplicate-like errors
      if (message.toLowerCase().includes("duplicate") || message.toLowerCase().includes("already exists")) {
        stats.duplicates++;
      } else {
        stats.errors++;
        console.error(`\n  WARNING: Failed to import fact: ${message}`);
      }
    }

    // Update progress every 10 facts or at the end
    if (processed % 10 === 0 || processed === totalLines) {
      renderProgress(processed, totalLines, stats);
    }
  }

  // Final progress + newline
  renderProgress(processed, totalLines, stats);
  console.error("");

  console.error(
    `\nImport complete: ${stats.imported} imported | ${stats.duplicates} duplicates | ` +
    `${stats.conflicts} conflicts | ${stats.errors} errors`
  );

  return stats;
}
