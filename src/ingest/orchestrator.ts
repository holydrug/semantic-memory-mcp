/**
 * Ingestion orchestrator — phased execution with progress tracking,
 * crash recovery via checkpoint, change detection, and ingestion lock.
 *
 * Sorts sources by phase (1->4), runs extraction strategies,
 * stores facts via memory_store with on-store validation,
 * and checkpoints state after each source.
 */

import { randomUUID } from "node:crypto";

import type { Config } from "../config.js";
import type { IngestionSource, Strategy } from "./scanner.js";
import type { ExtractionStrategy, ExtractedFact } from "./strategies/types.js";
import { documentationStrategy } from "./strategies/documentation.js";
import { codeAnalysisStrategy } from "./strategies/code-analysis.js";
import { pdfStrategy } from "./strategies/pdf.js";
import { apiContractsStrategy } from "./strategies/api-contracts.js";
import { dependencyGraphStrategy } from "./strategies/dependency-graph.js";
import { changelogStrategy } from "./strategies/changelog.js";
import { computeHashes, detectChanges } from "./change-detect.js";

// ── Types ────────────────────────────────────────────────────────────────

export interface ProgressEvent {
  type:
    | "source_start"
    | "source_progress"
    | "source_done"
    | "source_error"
    | "done";
  source?: string;
  filesTotal?: number;
  filesProcessed?: number;
  factsExtracted?: number;
  factsStored?: number;
  error?: string;
  runId?: string;
}

export interface SourceState {
  status: "pending" | "in_progress" | "done" | "error";
  phase: number;
  strategy: string;
  filesTotal: number;
  filesProcessed: number;
  factsStored: number;
  duplicatesSkipped: number;
  error?: string;
  completedAt?: string;
}

export interface IngestState {
  runId: string;
  startedAt: string;
  scanRoot: string;
  sources: Record<string, SourceState>;
}

export interface IngestLock {
  runId: string;
  pid: number;
  startedAt: string;
}

/**
 * Injectable store function type.
 * Called for each extracted fact. Returns true if stored, false if duplicate.
 */
export type StoreFactFn = (fact: ExtractedFact) => Promise<boolean>;

/**
 * Interface for checkpoint persistence (Qdrant metadata or in-memory).
 */
export interface CheckpointBackend {
  loadState(): Promise<IngestState | null>;
  saveState(state: IngestState): Promise<void>;
  clearState(): Promise<void>;
  loadLock(): Promise<IngestLock | null>;
  saveLock(lock: IngestLock): Promise<void>;
  clearLock(): Promise<void>;
  loadHashes(source: string): Promise<Map<string, string>>;
  saveHashes(source: string, hashes: Map<string, string>): Promise<void>;
}

// ── Strategy registry ────────────────────────────────────────────────────

const strategyMap: Record<Strategy, ExtractionStrategy> = {
  documentation: documentationStrategy,
  "code-analysis": codeAnalysisStrategy,
  pdf: pdfStrategy,
  "api-contracts": apiContractsStrategy,
  "dependency-graph": dependencyGraphStrategy,
  changelog: changelogStrategy,
};

export function getStrategy(name: Strategy): ExtractionStrategy {
  const strategy = strategyMap[name];
  if (!strategy) {
    throw new Error(`Unknown extraction strategy: ${name}`);
  }
  return strategy;
}

// ── Ingestion lock ──────────────────────────────────────────────────────

/**
 * Check if a PID is still alive.
 */
export function isPidAlive(pid: number): boolean {
  try {
    // signal 0 doesn't kill the process but checks if it exists
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if a lock is stale (process that created it is dead).
 */
export function isLockStale(lock: IngestLock): boolean {
  return !isPidAlive(lock.pid);
}

/**
 * Acquire ingestion lock. Returns true if lock acquired successfully.
 * If lock exists and process is alive, returns false.
 * If lock exists but process is dead (stale), steals lock.
 */
export async function acquireLock(
  runId: string,
  checkpoint: CheckpointBackend,
): Promise<boolean> {
  const existingLock = await checkpoint.loadLock();

  if (existingLock) {
    if (!isLockStale(existingLock)) {
      // Lock held by a live process
      return false;
    }
    // Stale lock -- steal it
    console.error(
      `[orchestrator] Stale lock detected (pid ${existingLock.pid}, runId ${existingLock.runId}). Stealing lock.`,
    );
  }

  const lock: IngestLock = {
    runId,
    pid: process.pid,
    startedAt: new Date().toISOString(),
  };
  await checkpoint.saveLock(lock);
  return true;
}

/**
 * Release ingestion lock.
 */
export async function releaseLock(
  runId: string,
  checkpoint: CheckpointBackend,
): Promise<void> {
  const lock = await checkpoint.loadLock();
  if (lock && lock.runId === runId) {
    await checkpoint.clearLock();
  }
}

// ── In-memory checkpoint backend ─────────────────────────────────────────

/**
 * In-memory implementation of CheckpointBackend.
 * Useful for testing and simple deployments.
 */
export class InMemoryCheckpoint implements CheckpointBackend {
  private state: IngestState | null = null;
  private lock: IngestLock | null = null;
  private hashes: Map<string, Map<string, string>> = new Map();

  async loadState(): Promise<IngestState | null> {
    return this.state;
  }
  async saveState(state: IngestState): Promise<void> {
    this.state = structuredClone(state);
  }
  async clearState(): Promise<void> {
    this.state = null;
  }
  async loadLock(): Promise<IngestLock | null> {
    return this.lock;
  }
  async saveLock(lock: IngestLock): Promise<void> {
    this.lock = { ...lock };
  }
  async clearLock(): Promise<void> {
    this.lock = null;
  }
  async loadHashes(source: string): Promise<Map<string, string>> {
    return this.hashes.get(source) ?? new Map();
  }
  async saveHashes(source: string, hashes: Map<string, string>): Promise<void> {
    this.hashes.set(source, new Map(hashes));
  }
}

// ── Orchestrator ────────────────────────────────────────────────────────

/**
 * Run the ingestion pipeline.
 *
 * 1. Acquire lock
 * 2. Load or create ingest state
 * 3. Sort sources by phase
 * 4. For each source: extract -> store -> checkpoint
 * 5. Release lock
 *
 * Yields ProgressEvent for each step.
 */
export async function* orchestrate(
  sources: IngestionSource[],
  config: Config,
  storeFn: StoreFactFn,
  checkpoint: CheckpointBackend,
  scanRoot?: string,
): AsyncGenerator<ProgressEvent> {
  const runId = randomUUID();

  // 1. Acquire lock
  const locked = await acquireLock(runId, checkpoint);
  if (!locked) {
    yield {
      type: "source_error",
      error: "Ingestion already running. Another process holds the lock.",
      runId,
    };
    return;
  }

  try {
    // 2. Load or create state
    let state = await checkpoint.loadState();
    const isResume = state !== null && hasIncomplete(state);

    if (!isResume) {
      // Fresh run or all-done state
      state = {
        runId,
        startedAt: new Date().toISOString(),
        scanRoot: scanRoot ?? "",
        sources: {},
      };

      // Initialize source states
      for (const src of sources) {
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
    } else {
      // Resume: update runId
      state!.runId = runId;
    }

    await checkpoint.saveState(state!);

    // 3. Sort sources by phase, then name
    const sortedSources = [...sources].sort(
      (a, b) => a.phase - b.phase || a.name.localeCompare(b.name),
    );

    // 4. Process each source
    for (const source of sortedSources) {
      const sourceState = state!.sources[source.name];

      // Skip completed sources (resume)
      if (sourceState?.status === "done") {
        continue;
      }

      // Yield start event
      yield {
        type: "source_start",
        source: source.name,
        filesTotal: source.files.length,
        runId,
      };

      // Update state to in_progress
      if (sourceState) {
        sourceState.status = "in_progress";
        sourceState.filesProcessed = 0;
        sourceState.factsStored = 0;
        sourceState.duplicatesSkipped = 0;
      }
      await checkpoint.saveState(state!);

      try {
        // Change detection: only process changed/new files
        const currentHashes = computeHashes(source.files);
        const storedHashes = await checkpoint.loadHashes(source.name);
        const changes = detectChanges(currentHashes, storedHashes);

        const filesToProcess = [...changes.changed, ...changes.added];

        // If all files unchanged, skip extraction
        if (filesToProcess.length === 0 && changes.deleted.length === 0) {
          if (sourceState) {
            sourceState.status = "done";
            sourceState.filesProcessed = source.files.length;
            sourceState.completedAt = new Date().toISOString();
          }
          await checkpoint.saveState(state!);
          await checkpoint.saveHashes(source.name, currentHashes);

          yield {
            type: "source_done",
            source: source.name,
            filesTotal: source.files.length,
            filesProcessed: source.files.length,
            factsStored: 0,
            runId,
          };
          continue;
        }

        // Get strategy
        const strategy = getStrategy(source.strategy);

        // Extract facts from changed/new files
        const facts = await strategy.extract(
          filesToProcess,
          source.context ?? "",
          config,
        );

        // Store facts
        let factsStored = 0;
        let duplicatesSkipped = 0;

        for (const fact of facts) {
          try {
            const stored = await storeFn(fact);
            if (stored) {
              factsStored++;
            } else {
              duplicatesSkipped++;
            }
          } catch (err) {
            console.error(
              `[orchestrator] Failed to store fact from ${source.name}: ${err instanceof Error ? err.message : err}`,
            );
          }
        }

        // Update state
        if (sourceState) {
          sourceState.status = "done";
          sourceState.filesProcessed = filesToProcess.length;
          sourceState.factsStored = factsStored;
          sourceState.duplicatesSkipped = duplicatesSkipped;
          sourceState.completedAt = new Date().toISOString();
        }
        await checkpoint.saveState(state!);
        await checkpoint.saveHashes(source.name, currentHashes);

        yield {
          type: "source_done",
          source: source.name,
          filesTotal: source.files.length,
          filesProcessed: filesToProcess.length,
          factsStored,
          runId,
        };
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        console.error(
          `[orchestrator] Source ${source.name} failed: ${errorMsg}`,
        );

        if (sourceState) {
          sourceState.status = "error";
          sourceState.error = errorMsg;
        }
        await checkpoint.saveState(state!);

        yield {
          type: "source_error",
          source: source.name,
          error: errorMsg,
          runId,
        };
        // Continue to next source (error isolation)
      }
    }

    // 5. Done
    yield { type: "done", runId };

    // Clear state if all done (next run starts fresh scan)
    const allDone = Object.values(state!.sources).every(
      (s) => s.status === "done",
    );
    if (allDone) {
      await checkpoint.clearState();
    }
  } finally {
    await releaseLock(runId, checkpoint);
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────

function hasIncomplete(state: IngestState): boolean {
  return Object.values(state.sources).some(
    (s) => s.status === "pending" || s.status === "in_progress" || s.status === "error",
  );
}
