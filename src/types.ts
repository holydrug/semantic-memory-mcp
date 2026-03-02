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
  close(): Promise<void>;
  getCandidateFacts?(scope: "global" | "project"): Promise<CandidateFact[]>;
  updateFactScope?(factId: number, scope: "global" | "project" | null): Promise<void>;
}

/** Dual-layer backend that exposes per-layer access for auto-routing */
export interface DualStorageBackend extends StorageBackend {
  getLayerBackend(scope: "global" | "project"): StorageBackend;
  readonly isDual: true;
}
