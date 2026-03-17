/**
 * CLI: ingest command -- synchronous with progress bar.
 *
 * Usage:
 *   npx semantic-memory-mcp ingest [--source X]
 */

import { resolve } from "node:path";
import type { StorageBackend, EmbedFn } from "../types.js";
import { isDualBackend } from "../types.js";
import { classifyScope } from "../classify.js";
import type { ProgressEvent } from "../ingest/orchestrator.js";
import { scanDirectory } from "../ingest/scanner.js";
import {
  orchestrate,
  InMemoryCheckpoint,
} from "../ingest/orchestrator.js";
import type { ExtractedFact } from "../ingest/strategies/types.js";
import { getConfig } from "../config.js";
import { initEmbeddings } from "../embeddings.js";
import { createBackend } from "../backend-factory.js";
import { createDualBackend } from "../dual.js";

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
      process.stderr.write(`  [${event.source ?? "?"}] `);
      break;

    case "source_progress":
      if (event.filesProcessed != null && event.filesTotal != null) {
        const bar = progressBar(event.filesProcessed, event.filesTotal);
        process.stderr.write(`\r  [${event.source ?? "?"}] ${bar} ${event.filesProcessed}/${event.filesTotal}`);
      }
      break;

    case "source_done":
      if (event.filesProcessed != null && event.filesTotal != null) {
        const bar = progressBar(event.filesTotal, event.filesTotal);
        process.stderr.write(
          `\r  [${event.source ?? "?"}] ${bar} ${event.filesTotal}/${event.filesTotal}` +
          ` | ${event.factsStored ?? 0} facts\n`,
        );
      } else {
        process.stderr.write(
          ` | ${event.factsStored ?? 0} facts\n`,
        );
      }
      break;

    case "source_error":
      process.stderr.write(`\n  ERROR: ${event.error}\n`);
      break;

    case "done":
      // Summary is printed by runIngest
      break;
  }
}

export async function runIngest(args: string[]): Promise<void> {
  // Parse CLI args
  let _sourceFilter: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--source" && i + 1 < args.length) {
      _sourceFilter = args[i + 1];
      i++;
    }
  }

  const config = getConfig();

  let db: StorageBackend;
  if (config.dualMode) {
    const projectBackend = await createBackend(config, "project");
    const globalBackend = await createBackend(config, "global");
    db = createDualBackend(projectBackend, globalBackend);
  } else {
    db = await createBackend(config, "project");
  }

  const embed = await initEmbeddings();

  const scanRoot = resolve(process.cwd());
  console.error(`Scanning ${scanRoot}...`);

  const scanResult = await scanDirectory(scanRoot);

  if (scanResult.sources.length === 0) {
    console.error("No indexable sources found.");
    await db.close();
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

  let totalFactsStored = 0;
  const errors: string[] = [];

  // Build store function
  const storeFn = async (fact: ExtractedFact): Promise<boolean> => {
    const scope = isDualBackend(db) ? classifyScope("has_fact") : null;
    const target = scope && isDualBackend(db) ? db.getLayerBackend(scope) : db;

    const [subjectEmb, objectEmb, factEmb] = await Promise.all([
      embed(fact.subject),
      embed(fact.object),
      embed(fact.fact),
    ]);

    const subjectId = await target.findOrCreateEntity(fact.subject, subjectEmb);
    const objectId = await target.findOrCreateEntity(fact.object, objectEmb);

    await target.storeFact({
      subjectId,
      predicate: fact.predicate,
      objectId,
      content: fact.fact,
      context: fact.context,
      source: fact.source,
      embedding: factEmb,
    });

    totalFactsStored++;
    return true;
  };

  const checkpoint = new InMemoryCheckpoint();
  const startTime = Date.now();

  for await (const event of orchestrate(
    scanResult.sources,
    config,
    storeFn,
    checkpoint,
    scanRoot,
  )) {
    handleProgress(event);

    if (event.type === "source_error" && event.error) {
      errors.push(event.error);
    }
  }

  const elapsed = formatElapsed(Date.now() - startTime);

  console.error(
    `\nDone! ${scanResult.sources.length} sources, ` +
    `${totalFactsStored} facts | ${elapsed}`,
  );

  if (errors.length > 0) {
    console.error(`\nErrors (${errors.length}):`);
    for (const err of errors) {
      console.error(`  - ${err}`);
    }
  }

  await db.close();
}
