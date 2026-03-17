import { z } from "zod";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { StorageBackend, EmbedFn } from "../types.js";
import type { IngestState } from "../ingest/types.js";
import { scanDirectory } from "../ingest/scanner.js";
import { orchestrate } from "../ingest/orchestrator.js";

/** In-memory registry of ingest runs */
const runs = new Map<string, IngestState>();

/** Exported for testing */
export function _getRuns(): Map<string, IngestState> {
  return runs;
}

/** Exported for testing */
export function _clearRuns(): void {
  runs.clear();
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

function getSourcesDone(state: IngestState): number {
  let count = 0;
  for (const s of Object.values(state.sources)) {
    if (s.status === "done" || s.status === "error") count++;
  }
  return count;
}

function getCurrentSource(state: IngestState): string | undefined {
  for (const [name, s] of Object.entries(state.sources)) {
    if (s.status === "in_progress") {
      return `${name} (${s.filesProcessed}/${s.filesTotal} files)`;
    }
  }
  return undefined;
}

export function registerIngestTool(
  server: McpServer,
  db: StorageBackend,
  embed: EmbedFn,
): void {
  server.tool(
    "memory_ingest",
    "Bulk-ingest project files into the knowledge base. " +
    "Starts async pipeline (returns runId). " +
    "Call with runId to check progress. " +
    "Call with runId + cancel to stop.",
    {
      path: z
        .string()
        .optional()
        .describe("Scan root directory (default: cwd)"),
      source: z
        .string()
        .optional()
        .describe("Re-ingest specific source only"),
      force: z
        .boolean()
        .optional()
        .describe("Re-ingest even if recently indexed"),
      runId: z
        .string()
        .optional()
        .describe("Check status of a running/completed ingest"),
      cancel: z
        .boolean()
        .optional()
        .describe("Cancel a running ingest (requires runId)"),
    },
    async ({ path, source, force: _force, runId, cancel }) => {
      // Mode 2: Check status
      if (runId && !cancel) {
        const state = runs.get(runId);
        if (!state) {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({ error: `Unknown runId: ${runId}` }),
            }],
          };
        }

        const elapsed = formatElapsed(Date.now() - new Date(state.startedAt).getTime());
        const sourcesTotal = Object.keys(state.sources).length;
        const sourcesDone = getSourcesDone(state);
        const currentSource = getCurrentSource(state);

        const result: Record<string, unknown> = {
          runId: state.runId,
          status: state.status,
          sourcesTotal,
          sourcesDone,
          factsStored: state.factsStored,
          elapsed,
        };

        if (currentSource) result.currentSource = currentSource;

        if (state.status === "done") {
          result.duplicatesSkipped = state.duplicatesSkipped;
          result.perSource = Object.entries(state.sources).map(([name, s]) => ({
            name,
            strategy: s.strategy,
            files: s.filesTotal,
            facts: s.factsStored,
            duplicates: s.duplicatesSkipped,
          }));
        }

        if (state.errors.length > 0) {
          result.errors = state.errors;
        }

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify(result),
          }],
        };
      }

      // Mode 3: Cancel
      if (runId && cancel) {
        const state = runs.get(runId);
        if (!state) {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({ error: `Unknown runId: ${runId}` }),
            }],
          };
        }

        if (state.status !== "running") {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                runId: state.runId,
                status: state.status,
                message: `Ingest is already ${state.status}, cannot cancel.`,
              }),
            }],
          };
        }

        state.cancelRequested = true;
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              runId: state.runId,
              status: "cancelling",
              message: "Cancel requested. Ingest will stop after current source completes.",
            }),
          }],
        };
      }

      // Mode 1: Start ingestion
      const scanRoot = resolve(path ?? process.cwd());
      const scanResult = scanDirectory(scanRoot, source);

      if (scanResult.sources.length === 0) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              status: "done",
              sourcesDetected: 0,
              message: "No indexable sources found in the directory.",
            }),
          }],
        };
      }

      const newRunId = `run_${randomUUID().slice(0, 8)}`;
      const state: IngestState = {
        runId: newRunId,
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

      runs.set(newRunId, state);

      // Fire and forget — orchestrator runs in background
      orchestrate({
        scanResult,
        db,
        embed,
        state,
      }).catch((err) => {
        state.status = "error";
        state.errors.push(err instanceof Error ? err.message : String(err));
        state.completedAt = new Date().toISOString();
      });

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            runId: newRunId,
            status: "running",
            sourcesDetected: scanResult.sources.length,
            message: "Ingestion started. Call memory_ingest with runId to check progress.",
          }),
        }],
      };
    },
  );
}
