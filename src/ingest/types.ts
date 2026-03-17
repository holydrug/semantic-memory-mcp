/**
 * Ingestion types shared across scanner, orchestrator, and tools.
 * Step 13: memory_ingest + memory_ingest_url + CLI ingest
 *
 * Re-exports core types from scanner and orchestrator,
 * and defines tool-layer run-tracking types.
 */

// Re-export from scanner/orchestrator so consumers can import from one place
export type { ScanResult, IngestionSource, Strategy } from "./scanner.js";
export type {
  ProgressEvent,
  SourceState,
  IngestState as OrchestratorState,
  StoreFactFn,
  CheckpointBackend,
} from "./orchestrator.js";
export { InMemoryCheckpoint } from "./orchestrator.js";

// ── Tool-layer run tracking ──────────────────────────────────────────────

export type IngestRunStatus = "running" | "done" | "error" | "cancelled";

export interface SourceRunState {
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

/**
 * In-memory state for tracking an ingest run in the MCP tool layer.
 * Distinct from the orchestrator's internal IngestState / checkpoint state.
 */
export interface IngestRunState {
  runId: string;
  status: IngestRunStatus;
  startedAt: string;
  scanRoot: string;
  sources: Record<string, SourceRunState>;
  cancelRequested: boolean;
  factsStored: number;
  duplicatesSkipped: number;
  errors: string[];
  completedAt?: string;
}
