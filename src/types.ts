export type EmbedFn = (text: string) => Promise<Float32Array>;

/** V3 config.json shape — single config file for all settings */
export interface ConfigV3 {
  version: 3;
  dataDir: string;               // absolute path
  neo4j: { uri: string; user: string; password: string };
  qdrant: { url: string; collection: string };
  embeddings: {
    provider: "builtin" | "ollama";
    model: string;
    dimension: number;
  };
  validation: {
    mode: "on-store" | "off";
    claudePath: string;
    model: string;
    conflictThreshold: number;
    sweepCooldownMin: number;
    sweepBatchSize: number;
    maxFactAgeDays: number;
    maxValidationsPerMinute: number;
  };
  ingest: { batchSize: number; model: string };
  layers: { mode: "auto" | "off"; globalDir: string | null };
}

export interface StoreFact {
  subjectId: number;
  predicate: string;
  objectId: number;
  content: string;
  context: string;
  source: string;
  embedding: Float32Array;
  scopeCandidate?: "global" | "project" | null;
  // v3 fields (optional — defaults applied if omitted)
  version?: string | null;
  validFrom?: string | null;
  validUntil?: string | null;
  supersededBy?: string | null;
  confidence?: number;
  lastValidated?: string;
}

export interface SearchResult {
  subject: string;
  predicate: string;
  object: string;
  fact: string;
  context: string;
  source: string;
  score: number;
  factId: string;
  sourceLayer?: "project" | "global";
  createdAt?: string;  // ISO 8601, populated when Qdrant returns results
  // v3 fields (populated with defaults for v2 facts)
  version?: string | null;
  validFrom?: string | null;
  validUntil?: string | null;
  supersededBy?: string | null;
  confidence?: number;
  lastValidated?: string;
}

/** Filters for Qdrant-powered search */
export interface SearchFilter {
  predicates?: string[];    // filter by predicate (keyword match)
  source?: string;          // filter by source (keyword match)
  since?: string;           // ISO 8601 date — facts not older than
  recencyBias?: number;     // 0.0–1.0 — weight of recency vs similarity
}

export interface GraphResult {
  matchedName: string;
  entities: string[];
  facts: Array<{
    subject: string;
    predicate: string;
    object: string;
    fact: string;
    factId: string;
    // v3 fields (optional — populated when available)
    supersededBy?: string | null;
    confidence?: number;
    lastValidated?: string | null;
    createdAt?: string | null;
  }>;
}

/** Options for graph traversal */
export interface GraphTraverseOptions {
  includeOutdated?: boolean;  // default: false — hide superseded facts
}

export interface EntityInfo {
  name: string;
  factCount: number;
  // v3 health score breakdown (optional — populated when available)
  healthCurrent?: number;
  healthReview?: number;
  healthOutdated?: number;
}

export interface CandidateFact {
  factId: number;
  subject: string;
  predicate: string;
  object: string;
  content: string;
  context: string;
  source: string;
  scopeCandidate: "global" | "project";
}

/** Async storage backend interface — implemented by Neo4j */
export interface StorageBackend {
  findOrCreateEntity(name: string, embedding: Float32Array): Promise<number>;
  storeFact(params: StoreFact): Promise<number>;
  searchFacts(embedding: Float32Array, limit: number): Promise<SearchResult[]>;
  graphTraverse(entityName: string, depth: number, options?: GraphTraverseOptions): Promise<GraphResult | null>;
  listEntities(pattern?: string): Promise<EntityInfo[]>;
  deleteFact(factId: number): Promise<boolean>;
  close(): Promise<void>;
  getCandidateFacts?(scope: "global" | "project"): Promise<CandidateFact[]>;
  updateFactScope?(factId: number, scope: "global" | "project" | null): Promise<void>;
  searchFactsFiltered?(
    embedding: Float32Array,
    limit: number,
    filter: SearchFilter,
  ): Promise<SearchResult[]>;
}

/** Dual-layer backend that exposes per-layer access for auto-routing */
export interface DualStorageBackend extends StorageBackend {
  getLayerBackend(scope: "global" | "project"): StorageBackend;
  readonly isDual: true;
}

/** Type guard: check if a backend is a dual-layer backend */
export function isDualBackend(db: StorageBackend): db is DualStorageBackend {
  return "isDual" in db && (db as DualStorageBackend).isDual === true;
}

/** Parse a fact ID string into layer + numeric ID (dual mode) or just numeric ID (single mode) */
export function parseFactId(
  id: string,
  isDual: boolean,
): { layer?: "project" | "global"; numericId: number } | { error: string } {
  if (isDual) {
    const colonIdx = id.indexOf(":");
    if (colonIdx === -1) {
      return { error: `expected format 'project:<id>' or 'global:<id>'` };
    }
    const layerStr = id.slice(0, colonIdx);
    const numericId = parseInt(id.slice(colonIdx + 1), 10);

    if (layerStr !== "project" && layerStr !== "global") {
      return { error: `unknown layer '${layerStr}'` };
    }
    if (isNaN(numericId)) {
      return { error: "invalid numeric ID" };
    }
    return { layer: layerStr, numericId };
  }

  const numericId = parseInt(id, 10);
  if (isNaN(numericId)) {
    return { error: "invalid numeric ID" };
  }
  return { numericId };
}

// ---------- v3: Confidence decay ----------

/** Compute how many days have elapsed since a given ISO 8601 date. */
function daysSince(isoDate: string): number {
  const then = new Date(isoDate).getTime();
  const now = Date.now();
  return Math.max(0, (now - then) / (1000 * 60 * 60 * 24));
}

/**
 * Compute the display confidence for a fact, incorporating time decay.
 *
 * - If the fact is superseded (`superseded_by` is set), returns 0.0.
 * - Otherwise, applies exponential decay (half-life = 365 days) based on
 *   the time since the fact was last validated (or created).
 * - Returns the minimum of the stored confidence and the decay value.
 */
export function computeDisplayConfidence(fact: {
  confidence: number;
  last_validated?: string | null;
  created_at?: string | null;
  superseded_by?: string | null;
}): number {
  if (fact.superseded_by != null) return 0.0;

  const referenceDate = fact.last_validated ?? fact.created_at ?? new Date().toISOString();
  const ageDays = daysSince(referenceDate);
  const decay = Math.pow(0.5, ageDays / 365);

  return Math.min(fact.confidence, decay);
}

/**
 * Map a display confidence score to a human-readable tag.
 *
 * - >= 0.7  -> "✅ Current"
 * - >= 0.4  -> "🔄 Needs review"
 * - <  0.4  -> "⚠️ Outdated"
 */
export function confidenceTag(displayConfidence: number): string {
  if (displayConfidence >= 0.7) return "✅ Current";
  if (displayConfidence >= 0.4) return "🔄 Needs review";
  return "⚠️ Outdated";
}
