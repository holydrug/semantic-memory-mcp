/**
 * Ingestion orchestrator — runs extraction pipeline for scanned sources.
 * Stub implementation for Step 13; full implementation in Step 12/17.
 */

import type { StorageBackend, EmbedFn } from "../types.js";
import type { ScanResult, IngestState, SourceState, ProgressCallback } from "./types.js";

export interface OrchestrateOptions {
  scanResult: ScanResult;
  db: StorageBackend;
  embed: EmbedFn;
  state: IngestState;
  onProgress?: ProgressCallback;
}

/**
 * Run the ingestion pipeline for all sources in the scan result.
 * Updates state in-place as sources are processed.
 *
 * This is a stub that simulates processing — full implementation
 * will use Claude CLI extraction strategies (Steps 12-17).
 */
export async function orchestrate(options: OrchestrateOptions): Promise<void> {
  const { scanResult, state, onProgress } = options;
  const startTime = Date.now();

  for (const source of scanResult.sources) {
    if (state.cancelRequested) {
      state.status = "cancelled";
      state.completedAt = new Date().toISOString();
      onProgress?.({
        type: "ingest_done",
        elapsed: formatElapsed(Date.now() - startTime),
      });
      return;
    }

    const sourceState: SourceState = {
      status: "in_progress",
      phase: source.phase,
      strategy: source.strategy,
      filesTotal: source.files.length,
      filesProcessed: 0,
      factsStored: 0,
      duplicatesSkipped: 0,
    };
    state.sources[source.name] = sourceState;

    onProgress?.({
      type: "source_start",
      sourceName: source.name,
      filesTotal: source.files.length,
    });

    try {
      // Process files — stub: just iterate and count
      for (const _file of source.files) {
        if (state.cancelRequested) break;

        sourceState.filesProcessed++;

        onProgress?.({
          type: "source_progress",
          sourceName: source.name,
          filesProcessed: sourceState.filesProcessed,
          filesTotal: sourceState.filesTotal,
        });

        // Yield to event loop so MCP stays responsive
        await new Promise<void>((resolve) => setImmediate(resolve));
      }

      sourceState.status = "done";
      sourceState.completedAt = new Date().toISOString();
      state.factsStored += sourceState.factsStored;
      state.duplicatesSkipped += sourceState.duplicatesSkipped;

      onProgress?.({
        type: "source_done",
        sourceName: source.name,
        factsStored: sourceState.factsStored,
        duplicatesSkipped: sourceState.duplicatesSkipped,
        elapsed: formatElapsed(Date.now() - startTime),
      });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      sourceState.status = "error";
      sourceState.error = errorMsg;
      state.errors.push(`${source.name}: ${errorMsg}`);

      onProgress?.({
        type: "source_error",
        sourceName: source.name,
        error: errorMsg,
      });
    }
  }

  if (!state.cancelRequested) {
    state.status = "done";
    state.completedAt = new Date().toISOString();
  }

  onProgress?.({
    type: "ingest_done",
    factsStored: state.factsStored,
    duplicatesSkipped: state.duplicatesSkipped,
    elapsed: formatElapsed(Date.now() - startTime),
  });
}

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
