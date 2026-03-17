/**
 * Ingestion types shared across scanner, orchestrator, and tools.
 * Step 13: memory_ingest + memory_ingest_url + CLI ingest
 */

export interface SourceInfo {
  name: string;
  strategy: string;
  phase: number;
  files: string[];
}

export interface ScanResult {
  root: string;
  sources: SourceInfo[];
}

export type IngestStatus = "running" | "done" | "error" | "cancelled";

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
  status: IngestStatus;
  startedAt: string;
  scanRoot: string;
  sources: Record<string, SourceState>;
  cancelRequested: boolean;
  factsStored: number;
  duplicatesSkipped: number;
  errors: string[];
  completedAt?: string;
}

export interface ProgressEvent {
  type: "source_start" | "source_progress" | "source_done" | "source_error" | "ingest_done";
  sourceName?: string;
  filesProcessed?: number;
  filesTotal?: number;
  factsStored?: number;
  duplicatesSkipped?: number;
  error?: string;
  elapsed?: string;
}

export type ProgressCallback = (event: ProgressEvent) => void;
