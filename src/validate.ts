import type { Config } from "./config.js";
import type { QdrantSearchResult } from "./qdrant.js";
import { spawnClaude } from "./claude.js";
import type { SpawnClaudeOpts } from "./claude.js";

/**
 * Decision from Claude Sonnet about how to resolve a conflict between
 * an existing fact and a new fact.
 */
export interface ConflictDecision {
  decisions: Array<{
    existingId: string;
    action: "SUPERSEDE" | "DUPLICATE" | "INDEPENDENT";
    reason: string;
  }>;
}

/**
 * Result of conflict detection and resolution.
 */
export interface ValidationResult {
  action: "STORED" | "SUPERSEDED" | "DUPLICATE" | "FORCED";
  superseded?: Array<{ id: string; fact: string }>;
  existing?: { id: string; fact: string };
  reason?: string;
}

/**
 * Interface for the Qdrant search function used by validation.
 * Decoupled from the full QdrantBackend to enable unit testing.
 */
export interface ConflictSearchFn {
  (embedding: number[], limit: number, filter?: {
    layer?: string;
    must_not?: Array<Record<string, unknown>>;
  }): Promise<QdrantSearchResult[]>;
}

/**
 * Interface for marking a fact as superseded in the backend.
 */
export interface SupersedeFactFn {
  (factId: number, supersededBy: string, reason: string): Promise<void>;
}

/**
 * Injectable spawnClaude function type (for testing).
 */
export type SpawnClaudeFn = <T>(opts: SpawnClaudeOpts) => Promise<T>;

/**
 * Simple sliding window rate limiter for Claude CLI validation calls.
 */
export class RateLimiter {
  private timestamps: number[] = [];

  constructor(private readonly maxPerMinute: number) {}

  async acquire(): Promise<void> {
    const now = Date.now();
    const windowStart = now - 60_000;

    // Remove timestamps outside the window
    this.timestamps = this.timestamps.filter((t) => t > windowStart);

    if (this.timestamps.length >= this.maxPerMinute) {
      // Wait until the oldest timestamp in the window expires
      const oldest = this.timestamps[0]!;
      const waitMs = oldest + 60_000 - now + 10; // +10ms buffer
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      // Clean up again after waiting
      const newNow = Date.now();
      this.timestamps = this.timestamps.filter((t) => t > newNow - 60_000);
    }

    this.timestamps.push(Date.now());
  }

  /** Current count of calls in the sliding window (for testing) */
  get currentCount(): number {
    const windowStart = Date.now() - 60_000;
    this.timestamps = this.timestamps.filter((t) => t > windowStart);
    return this.timestamps.length;
  }
}

// Module-level rate limiter instance (shared across all validation calls)
let _rateLimiter: RateLimiter | null = null;

export function getRateLimiter(maxPerMinute: number): RateLimiter {
  if (!_rateLimiter || _rateLimiter["maxPerMinute"] !== maxPerMinute) {
    _rateLimiter = new RateLimiter(maxPerMinute);
  }
  return _rateLimiter;
}

/** Reset the shared rate limiter (for testing) */
export function resetRateLimiter(): void {
  _rateLimiter = null;
}

/**
 * Build the conflict resolution prompt for Claude Sonnet.
 */
export function buildConflictPrompt(
  existingFacts: Array<{ id: number; score: number; fact: string; subject: string; predicate: string; object: string }>,
  newFact: { subject: string; predicate: string; object: string; fact: string },
): string {
  const existingBlock = existingFacts
    .map((f) => `  - ID: ${f.id}, Score: ${f.score.toFixed(3)}, Fact: "${f.fact}" [${f.subject}] -[${f.predicate}]-> [${f.object}]`)
    .join("\n");

  return `Compare existing fact(s) vs new fact.

Existing:
${existingBlock}

New: "${newFact.fact}" [${newFact.subject}] -[${newFact.predicate}]-> [${newFact.object}]

For each existing fact, decide:
  SUPERSEDE — new replaces old (version update, correction)
  DUPLICATE — same info, skip storing
  INDEPENDENT — different facts, keep both

If versions involved (e.g. existing='18', new='20'), SUPERSEDE.
If existing='>=18' and new='20', INDEPENDENT (both valid).

Respond as JSON: { "decisions": [{ "existingId": "<id>", "action": "SUPERSEDE|DUPLICATE|INDEPENDENT", "reason": "<brief reason>" }] }`;
}

/**
 * Detect and resolve conflicts for a new fact before storing it.
 *
 * Flow:
 * 1. Qdrant similarity search (score > conflictThreshold, same layer, not superseded)
 * 2. No conflicts -> fast path: return STORED
 * 3. Conflicts found -> spawnClaude for resolution
 * 4. Apply decisions: SUPERSEDE / DUPLICATE / INDEPENDENT
 */
export async function detectAndResolveConflicts(
  newFact: {
    subject: string;
    predicate: string;
    object: string;
    fact: string;
    context: string;
    source: string;
    version?: string;
    embedding: number[];
  },
  config: Config,
  searchFn: ConflictSearchFn,
  supersedeFn: SupersedeFactFn,
  layer?: string | null,
  spawnClaudeFn?: SpawnClaudeFn,
): Promise<ValidationResult> {
  const claudeFn = spawnClaudeFn ?? spawnClaude;
  // Qdrant similarity search: same layer, not superseded, above threshold
  const candidates = await searchFn(
    newFact.embedding,
    10, // check up to 10 similar facts
    {
      layer: layer ?? undefined,
    },
  );

  // Filter by threshold and exclude superseded facts
  const conflicts = candidates.filter((c) => {
    if (c.score < config.validation.conflictThreshold) return false;
    // Skip already superseded facts
    if (c.payload && "superseded_by" in c.payload && c.payload.superseded_by) return false;
    return true;
  });

  // Fast path: no conflicts
  if (conflicts.length === 0) {
    return { action: "STORED" };
  }

  // Rate limit Claude CLI calls
  const rateLimiter = getRateLimiter(config.validation.maxValidationsPerMinute);
  await rateLimiter.acquire();

  // Spawn Claude Sonnet for conflict resolution
  const prompt = buildConflictPrompt(
    conflicts.map((c) => ({
      id: c.id,
      score: c.score,
      fact: c.payload.fact,
      subject: c.payload.subject,
      predicate: c.payload.predicate,
      object: c.payload.object,
    })),
    newFact,
  );

  const decision = await claudeFn<ConflictDecision>({
    prompt,
    model: config.validation.model,
    maxTurns: 1,
    timeout: 30_000,
    claudePath: config.validation.claudePath,
  });

  // Apply decisions
  const supersededList: Array<{ id: string; fact: string }> = [];
  let hasDuplicate = false;
  let duplicateExisting: { id: string; fact: string } | undefined;
  let lastReason: string | undefined;

  for (const d of decision.decisions) {
    const existingId = String(d.existingId);
    const conflict = conflicts.find((c) => String(c.id) === existingId);

    switch (d.action) {
      case "SUPERSEDE": {
        // Mark old fact as superseded — the new_id will be set after storing
        // For now, mark with a placeholder that the caller will update
        await supersedeFn(
          parseInt(existingId, 10),
          "__pending__", // caller sets the real new fact ID after store
          d.reason,
        );
        supersededList.push({
          id: existingId,
          fact: conflict?.payload.fact ?? "",
        });
        lastReason = d.reason;
        break;
      }
      case "DUPLICATE": {
        hasDuplicate = true;
        duplicateExisting = {
          id: existingId,
          fact: conflict?.payload.fact ?? "",
        };
        lastReason = d.reason;
        break;
      }
      case "INDEPENDENT": {
        // No action needed — store alongside
        lastReason = d.reason;
        break;
      }
    }
  }

  // If any decision was DUPLICATE, skip storing entirely
  if (hasDuplicate && duplicateExisting) {
    return {
      action: "DUPLICATE",
      existing: duplicateExisting,
      reason: lastReason,
    };
  }

  // If any facts were superseded, return SUPERSEDED
  if (supersededList.length > 0) {
    return {
      action: "SUPERSEDED",
      superseded: supersededList,
      reason: lastReason,
    };
  }

  // All decisions were INDEPENDENT — store as normal
  return { action: "STORED", reason: lastReason };
}
