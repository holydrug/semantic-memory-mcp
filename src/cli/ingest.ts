/**
 * CLI: ingest command — synchronous with progress bar.
 *
 * Usage:
 *   npx semantic-memory-mcp ingest [--source X]
 */

import { resolve } from "node:path";
import type { StorageBackend, EmbedFn } from "../types.js";
import type { IngestState, ProgressEvent } from "../ingest/types.js";
import { scanDirectory } from "../ingest/scanner.js";
import { orchestrate } from "../ingest/orchestrator.js";
import { randomUUID } from "node:crypto";

function formatElapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) return `${minutes}m ${remainingSeconds}s`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h ${remainingMinutes}m`;
}

function progressBar(done: number, total: number, width: number = 20): string {
  if (total === 0) return "\u2588".repeat(width);
  const fraction = Math.min(done / total, 1);
  const filled = Math.round(fraction * width);
  const empty = width - filled;
  return "\u2588".repeat(filled) + "\u2591".repeat(empty);
}

function handleProgress(event: ProgressEvent): void {
  switch (event.type) {
    case "source_start":
      process.stderr.write(`  [${event.sourceName}] `);
      break;

    case "source_progress":
      if (event.filesProcessed != null && event.filesTotal != null) {
        const bar = progressBar(event.filesProcessed, event.filesTotal);
        process.stderr.write(`\r  [${event.sourceName}] ${bar} ${event.filesProcessed}/${event.filesTotal}`);
      }
      break;

    case "source_done":
      if (event.filesProcessed != null && event.filesTotal != null) {
        const bar = progressBar(event.filesTotal, event.filesTotal);
        process.stderr.write(
          `\r  [${event.sourceName}] ${bar} ${event.filesTotal}/${event.filesTotal}` +
          ` | ${event.factsStored ?? 0} facts | ${event.elapsed ?? ""}\n`,
        );
      } else {
        process.stderr.write(
          ` | ${event.factsStored ?? 0} facts | ${event.elapsed ?? ""}\n`,
        );
      }
      break;

    case "source_error":
      process.stderr.write(`\n  ERROR: ${event.error}\n`);
      break;

    case "ingest_done":
      // Summary is printed by runIngestCli
      break;
  }
}

export interface IngestCliOptions {
  args: string[];
  db: StorageBackend;
  embed: EmbedFn;
}

export async function runIngestCli(options: IngestCliOptions): Promise<void> {
  const { args, db, embed } = options;

  // Parse CLI args
  let sourceFilter: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--source" && i + 1 < args.length) {
      sourceFilter = args[i + 1];
      i++;
    }
  }

  const scanRoot = resolve(process.cwd());
  console.error(`Scanning ${scanRoot}...`);

  const scanResult = scanDirectory(scanRoot, sourceFilter);

  if (scanResult.sources.length === 0) {
    console.error("No indexable sources found.");
    return;
  }

  // Group by phase for display
  const byPhase = new Map<number, string[]>();
  for (const src of scanResult.sources) {
    const list = byPhase.get(src.phase) ?? [];
    list.push(`${src.name} (${src.files.length} files)`);
    byPhase.set(src.phase, list);
  }

  console.error(`Detected ${scanResult.sources.length} sources:`);
  for (const [phase, sources] of [...byPhase.entries()].sort((a, b) => a[0] - b[0])) {
    console.error(`  Phase ${phase}: ${sources.join(", ")}`);
  }
  console.error("");

  const state: IngestState = {
    runId: `run_${randomUUID().slice(0, 8)}`,
    status: "running",
    startedAt: new Date().toISOString(),
    scanRoot,
    sources: {},
    cancelRequested: false,
    factsStored: 0,
    duplicatesSkipped: 0,
    errors: [],
  };

  // Initialize source states
  for (const src of scanResult.sources) {
    state.sources[src.name] = {
      status: "pending",
      phase: src.phase,
      strategy: src.strategy,
      filesTotal: src.files.length,
      filesProcessed: 0,
      factsStored: 0,
      duplicatesSkipped: 0,
    };
  }

  const startTime = Date.now();

  await orchestrate({
    scanResult,
    db,
    embed,
    state,
    onProgress: handleProgress,
  });

  const elapsed = formatElapsed(Date.now() - startTime);

  console.error(
    `\nDone! ${scanResult.sources.length} sources, ` +
    `${state.factsStored} facts` +
    (state.duplicatesSkipped > 0 ? ` (${state.duplicatesSkipped} duplicates)` : "") +
    ` | ${elapsed}`,
  );

  if (state.errors.length > 0) {
    console.error(`\nErrors (${state.errors.length}):`);
    for (const err of state.errors) {
      console.error(`  - ${err}`);
    }
  }
}
