import { QdrantClient } from "@qdrant/js-client-rest";

export interface QdrantPoint {
  id: number;              // == Neo4j id(f), uint64
  vector: number[];
  payload: {
    layer: string | null;
    subject: string;
    predicate: string;
    object: string;
    fact: string;
    context: string;
    source: string;
    scope_candidate: string | null;
    created_at: string;    // ISO 8601
  };
}

export interface QdrantFilter {
  layer?: string;
  predicates?: string[];
  source?: string;
  since?: string;          // ISO 8601
}

export interface QdrantSearchResult {
  id: number;
  score: number;
  payload: QdrantPoint["payload"];
}

export interface QdrantBackend {
  ensureCollection(dim: number): Promise<void>;
  upsertFact(point: QdrantPoint): Promise<void>;
  batchUpsert(points: QdrantPoint[]): Promise<void>;
  searchFacts(embedding: number[], limit: number, filter?: QdrantFilter): Promise<QdrantSearchResult[]>;
  deleteFact(neo4jFactId: number): Promise<void>;
  deleteMany(ids: number[]): Promise<void>;
  scrollIds(): Promise<number[]>;
}

export function initQdrant(url: string, collection: string, apiKey?: string): QdrantBackend {
  const client = new QdrantClient({ url, apiKey });

  async function ensureCollection(dim: number): Promise<void> {
    let exists = false;
    try {
      const info = await client.getCollection(collection);
      exists = true;
      const existingDim = info.config?.params?.vectors;
      const currentDim = typeof existingDim === "object" && "size" in existingDim
        ? (existingDim as { size: number }).size
        : undefined;
      if (currentDim !== undefined && currentDim !== dim) {
        throw new Error(
          `Collection '${collection}' has dimension ${currentDim}, but current embedding provider uses ${dim}.\n` +
          `Run: semantic-memory-mcp migrate-qdrant --recreate`
        );
      }
    } catch (err) {
      if (exists) throw err; // dimension mismatch — re-throw
      // Collection doesn't exist — create it
    }

    if (!exists) {
      await client.createCollection(collection, {
        vectors: { size: dim, distance: "Cosine" },
      });
    }

    // Create payload indexes (idempotent)
    const indexes: Array<{ field: string; type: "keyword" | "datetime" }> = [
      { field: "layer", type: "keyword" },
      { field: "predicate", type: "keyword" },
      { field: "source", type: "keyword" },
      { field: "created_at", type: "datetime" },
    ];
    for (const { field, type } of indexes) {
      try {
        await client.createPayloadIndex(collection, {
          field_name: field,
          field_schema: type,
        });
      } catch (err) {
        // Index already exists — OK, skip
        if (!String(err).includes("already exists")) throw err;
      }
    }
  }

  async function upsertFact(point: QdrantPoint): Promise<void> {
    await client.upsert(collection, {
      points: [{ id: point.id, vector: point.vector, payload: point.payload }],
    });
  }

  async function batchUpsert(points: QdrantPoint[]): Promise<void> {
    for (let i = 0; i < points.length; i += 100) {
      const batch = points.slice(i, i + 100);
      await client.upsert(collection, {
        points: batch.map((p) => ({ id: p.id, vector: p.vector, payload: p.payload })),
      });
    }
  }

  async function searchFacts(
    embedding: number[],
    limit: number,
    filter?: QdrantFilter,
  ): Promise<QdrantSearchResult[]> {
    const must: Array<Record<string, unknown>> = [];

    if (filter?.layer) {
      must.push({ key: "layer", match: { value: filter.layer } });
    }
    if (filter?.predicates && filter.predicates.length > 0) {
      must.push({ key: "predicate", match: { any: filter.predicates } });
    }
    if (filter?.source) {
      must.push({ key: "source", match: { value: filter.source } });
    }
    if (filter?.since) {
      must.push({ key: "created_at", range: { gte: filter.since } });
    }

    const results = await client.search(collection, {
      vector: embedding,
      limit,
      filter: must.length > 0 ? { must } : undefined,
      with_payload: true,
    });

    return results.map((r) => ({
      id: r.id as number,
      score: r.score,
      payload: r.payload as QdrantPoint["payload"],
    }));
  }

  async function deleteFact(neo4jFactId: number): Promise<void> {
    await client.delete(collection, {
      points: [neo4jFactId],
    });
  }

  async function deleteMany(ids: number[]): Promise<void> {
    for (let i = 0; i < ids.length; i += 100) {
      const batch = ids.slice(i, i + 100);
      await client.delete(collection, { points: batch });
    }
  }

  async function scrollIds(): Promise<number[]> {
    const allIds: number[] = [];
    let offset: number | undefined;

    for (;;) {
      const result = await client.scroll(collection, {
        limit: 1000,
        offset,
        with_payload: false,
        with_vector: false,
      });

      for (const point of result.points) {
        allIds.push(point.id as number);
      }

      if (!result.next_page_offset) break;
      offset = result.next_page_offset as number;
    }

    return allIds;
  }

  return {
    ensureCollection,
    upsertFact,
    batchUpsert,
    searchFacts,
    deleteFact,
    deleteMany,
    scrollIds,
  };
}
