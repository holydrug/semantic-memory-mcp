import { z } from "zod";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config.js";
import type { StorageBackend, EmbedFn } from "../types.js";
import { isDualBackend } from "../types.js";
import { classifyScope } from "../classify.js";
import type { IngestRunState } from "../ingest/types.js";
import { scanDirectory } from "../ingest/scanner.js";
import {
  orchestrate,
  InMemoryCheckpoint,
} from "../ingest/orchestrator.js";
import type { ExtractedFact } from "../ingest/strategies/types.js";

/** In-memory registry of ingest runs */
const runs = new Map<string, IngestRunState>();

/** Exported for testing */
export function _getRuns(): Map<string, IngestRunState> {
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

function getSourcesDone(state: IngestRunState): number {
  let count = 0;
  for (const s of Object.values(state.sources)) {
    if (s.status === "done" || s.status === "error") count++;
  }
  return count;
}

function getCurrentSource(state: IngestRunState): string | undefined {
  for (const [name, s] of Object.entries(state.sources)) {
    if (s.status === "in_progress") {
      return `${name} (${s.filesProcessed}/${s.filesTotal} files)`;
    }
  }
  return undefined;
}

/**
 * Build a store function that embeds and persists each extracted fact.
 */
function makeStoreFn(
  db: StorageBackend,
  embed: EmbedFn,
  state: IngestRunState,
): (fact: ExtractedFact) => Promise<boolean> {
  return async (fact: ExtractedFact): Promise<boolean> => {
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

    state.factsStored++;
    return true;
  };
}

export function registerIngestTool(
  server: McpServer,
  db: StorageBackend,
  embed: EmbedFn,
  _config: Config,
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
    async ({ path, source: _source, force: _force, runId, cancel }) => {
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
      const scanResult = await scanDirectory(scanRoot);

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
      const state: IngestRunState = {
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
      const storeFn = makeStoreFn(db, embed, state);
      const checkpoint = new InMemoryCheckpoint();
      const config = _config;

      void (async () => {
        try {
          for await (const event of orchestrate(
            scanResult.sources,
            config,
            storeFn,
            checkpoint,
            scanRoot,
          )) {
            // Update tool-layer state from orchestrator events
            if (event.source) {
              const srcState = state.sources[event.source];
              if (srcState) {
                if (event.type === "source_start") {
                  srcState.status = "in_progress";
                } else if (event.type === "source_done") {
                  srcState.status = "done";
                  srcState.filesProcessed = event.filesProcessed ?? 0;
                  srcState.factsStored = event.factsStored ?? 0;
                  srcState.completedAt = new Date().toISOString();
                } else if (event.type === "source_error") {
                  srcState.status = "error";
                  srcState.error = event.error;
                  state.errors.push(event.error ?? "Unknown error");
                }
              }
            }
            if (event.type === "done") {
              state.status = "done";
              state.completedAt = new Date().toISOString();
            }
          }
          if (state.status === "running") {
            state.status = "done";
            state.completedAt = new Date().toISOString();
          }
        } catch (err: unknown) {
          state.status = "error";
          state.errors.push(err instanceof Error ? err.message : String(err));
          state.completedAt = new Date().toISOString();
        }
      })();

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
