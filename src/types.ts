export type EmbedFn = (text: string) => Promise<Float32Array>;

export interface StoreFact {
  subjectId: number;
  predicate: string;
  objectId: number;
  content: string;
  context: string;
  source: string;
  embedding: Float32Array;
  scopeCandidate?: "global" | "project" | null;
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
  }>;
}

export interface EntityInfo {
  name: string;
  factCount: number;
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

/** Async storage backend interface — implemented by SQLite and Neo4j */
export interface StorageBackend {
  findOrCreateEntity(name: string, embedding: Float32Array): Promise<number>;
  storeFact(params: StoreFact): Promise<number>;
  searchFacts(embedding: Float32Array, limit: number): Promise<SearchResult[]>;
  graphTraverse(entityName: string, depth: number): Promise<GraphResult | null>;
  listEntities(pattern?: string): Promise<EntityInfo[]>;
  deleteFact(factId: number): Promise<boolean>;
  close(): Promise<void>;
  getCandidateFacts?(scope: "global" | "project"): Promise<CandidateFact[]>;
  updateFactScope?(factId: number, scope: "global" | "project" | null): Promise<void>;
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
