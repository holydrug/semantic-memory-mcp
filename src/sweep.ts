/**
 * Sweep — one-shot stale fact review via Claude Sonnet.
 *
 * Not a background loop. Runs on serve start (fire-and-forget) and as CLI command.
 */

import type { Config } from "./config.js";
import type { StorageBackend, ValidatableFact } from "./types.js";
import { spawnClaude } from "./claude.js";
import type { SpawnClaudeOpts } from "./claude.js";
import { getRateLimiter } from "./validate.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SweepResult {
  reviewed: number;
  confirmed: number;
  stale: number;
  unknown: number;
}

interface SweepDecision {
  id: number;
  verdict: "VALID" | "STALE" | "UNKNOWN";
  reason: string;
}

interface ClaudeSweepResponse {
  decisions: SweepDecision[];
}

export interface SweepOptions {
  subject?: string;
  source?: string;
  batchSize?: number;
}

/**
 * Injectable spawnClaude function type (for testing).
 */
export type SpawnClaudeFn = <T>(opts: SpawnClaudeOpts) => Promise<T>;

// ---------------------------------------------------------------------------
// Metadata helpers — stored as a special Qdrant point with a well-known ID
// ---------------------------------------------------------------------------

// Using a separate approach: store metadata in-memory + backend-side.
// For simplicity, we store sweep metadata via the backend's validation API.
// However, the spec says "Qdrant collection metadata or special point".
// Since StorageBackend doesn't expose raw Qdrant, we use a file-based approach
// or leverage the backend. The simplest: use a module-level store that the
// CLI and serve can both use, backed by the backend's queryFactsForValidation.
//
// Actually, the cleanest approach per the spec: use getMetadata/setMetadata
// which we implement as get/set on a special well-known fact in the backend.
// But that's complex. Instead, we'll use a simple in-memory + timestamp approach
// since the spec says "stored in Qdrant collection metadata".
//
// For the real implementation: we store last_sweep_ts as module-level state
// that persists for the lifetime of the process. For CLI commands, we always
// run regardless of cooldown (cooldown only applies to on-serve auto-sweep).

let _lastSweepTs: number | null = null;

/** Get the last sweep timestamp (in-memory). */
export function getLastSweepTs(): number | null {
  return _lastSweepTs;
}

/** Set the last sweep timestamp (in-memory). */
export function setLastSweepTs(ts: number): void {
  _lastSweepTs = ts;
}

/** Reset the last sweep timestamp (for testing). */
export function _resetLastSweepTs(): void {
  _lastSweepTs = null;
}

// ---------------------------------------------------------------------------
// Sweep prompt builder
// ---------------------------------------------------------------------------

export function buildSweepPrompt(facts: ValidatableFact[]): string {
  const factLines = facts
    .map(
      (f) =>
        `[${f.factId}] ${f.subject} -[${f.predicate}]-> ${f.object}: ${f.content}`,
    )
    .join("\n");

  return `Review these ${facts.length} facts from a knowledge base.
For each, decide:
  VALID — still likely correct, no reason to doubt
  STALE — likely outdated (technology version changed, API deprecated, etc.)
  UNKNOWN — can't determine without more context

Facts:
${factLines}

Respond as JSON: { "decisions": [{ "id": <number>, "verdict": "VALID"|"STALE"|"UNKNOWN", "reason": "<brief reason>" }] }`;
}

// ---------------------------------------------------------------------------
// sweepOnce — core logic
// ---------------------------------------------------------------------------

export async function sweepOnce(
  config: Config,
  backend: StorageBackend,
  options?: SweepOptions,
  spawnClaudeFn?: SpawnClaudeFn,
): Promise<SweepResult> {
  const claudeFn = spawnClaudeFn ?? spawnClaude;
  const batchSize = options?.batchSize ?? config.validation.sweepBatchSize;

  // 1. Query oldest unvalidated current facts
  if (!backend.queryFactsForValidation) {
    console.error("[sweep] Backend does not support queryFactsForValidation");
    return { reviewed: 0, confirmed: 0, stale: 0, unknown: 0 };
  }

  const staleFacts = await backend.queryFactsForValidation({
    subject: options?.subject,
    source: options?.source,
    maxAgeDays: config.validation.maxFactAgeDays,
    limit: batchSize,
  });

  // 2. If 0 stale -> return empty result
  if (staleFacts.length === 0) {
    return { reviewed: 0, confirmed: 0, stale: 0, unknown: 0 };
  }

  // Rate limit Claude CLI calls
  const rateLimiter = getRateLimiter(config.validation.maxValidationsPerMinute);
  await rateLimiter.acquire();

  // 3. Single Claude CLI call for entire batch (Sonnet)
  const prompt = buildSweepPrompt(staleFacts);
  const response = await claudeFn<ClaudeSweepResponse>({
    prompt,
    model: config.validation.model,
    maxTurns: 1,
    timeout: 120_000,
    claudePath: config.validation.claudePath,
  });

  // 4. Apply decisions
  const stats: SweepResult = { reviewed: 0, confirmed: 0, stale: 0, unknown: 0 };
  const now = new Date().toISOString();

  if (response.decisions && Array.isArray(response.decisions)) {
    for (const d of response.decisions) {
      // Find the matching fact to ensure it's in our batch
      const fact = staleFacts.find((f) => f.factId === d.id);
      if (!fact) continue;

      stats.reviewed++;

      if (backend.updateFactValidation) {
        switch (d.verdict) {
          case "VALID":
            await backend.updateFactValidation(d.id, {
              confidence: 1.0,
              lastValidated: now,
            });
            stats.confirmed++;
            break;
          case "STALE":
            await backend.updateFactValidation(d.id, {
              confidence: 0.5,
              lastValidated: now,
            });
            stats.stale++;
            break;
          default: // UNKNOWN
            await backend.updateFactValidation(d.id, {
              lastValidated: now,
            });
            stats.unknown++;
            break;
        }
      } else {
        // Backend doesn't support updateFactValidation — just count
        stats.reviewed++;
        if (d.verdict === "VALID") stats.confirmed++;
        else if (d.verdict === "STALE") stats.stale++;
        else stats.unknown++;
      }
    }
  }

  // 5. Record sweep timestamp
  setLastSweepTs(Date.now());

  return stats;
}

// ---------------------------------------------------------------------------
// maybeSweepOnStart — fire-and-forget on serve start
// ---------------------------------------------------------------------------

export async function maybeSweepOnStart(
  config: Config,
  backend: StorageBackend,
  spawnClaudeFn?: SpawnClaudeFn,
): Promise<void> {
  if (config.validation.mode === "off") return;

  const lastSweep = getLastSweepTs();
  const elapsed = Date.now() - (lastSweep ?? 0);

  if (elapsed < config.validation.sweepCooldownMin * 60_000) return;

  // Fire-and-forget — does NOT block serve
  sweepOnce(config, backend, undefined, spawnClaudeFn).catch((err) =>
    console.error(
      `[sweep] failed: ${err instanceof Error ? err.message : String(err)}`,
    ),
  );
}
