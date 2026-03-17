import neo4j, { type Driver, type Session } from "neo4j-driver";
import { getConfig } from "./config.js";
import type {
  StoreFact,
  SearchResult,
  SearchFilter,
  GraphResult,
  GraphTraverseOptions,
  EntityInfo,
  CandidateFact,
  ValidatableFact,
  StorageBackend,
} from "./types.js";
import { computeDisplayConfidence, confidenceTag } from "./types.js";
import type { QdrantBackend, QdrantFilter } from "./qdrant.js";

function vectorIndexQuery(indexName: string, label: string, dim: number): string {
  return `CREATE VECTOR INDEX ${indexName} IF NOT EXISTS
    FOR (n:${label}) ON (n.embedding)
    OPTIONS {indexConfig: {
      \`vector.dimensions\`: ${dim},
      \`vector.similarity_function\`: 'cosine'
    }}`;
}

async function ensureSchema(session: Session, dim: number): Promise<void> {
  // Drop old name-only unique constraint (can't have same entity in both layers)
  try {
    await session.run("DROP CONSTRAINT entity_name IF EXISTS");
  } catch {
    // constraint may not exist
  }

  // Composite index on (name, layer) for performance
  await session.run(
    "CREATE INDEX entity_name_layer IF NOT EXISTS FOR (e:Entity) ON (e.name, e.layer)",
  );

  // Migrate existing nodes that lack a layer property
  await session.run("MATCH (n) WHERE n.layer IS NULL SET n.layer = 'project'");

  await session.run(vectorIndexQuery("entity_embedding", "Entity", dim));
  await session.run(vectorIndexQuery("fact_embedding", "Fact", dim));
  await session.run(
    "CREATE FULLTEXT INDEX fact_content IF NOT EXISTS FOR (f:Fact) ON EACH [f.content, f.context]",
  );
}

export function initNeo4j(layer?: string, qdrant?: QdrantBackend): StorageBackend {
  const config = getConfig();
  const driver: Driver = neo4j.driver(
    config.neo4jUri,
    neo4j.auth.basic(config.neo4jUser, config.neo4jPassword),
  );

  let schemaReady = false;

  async function withSession<T>(fn: (session: Session) => Promise<T>): Promise<T> {
    const session = driver.session();
    try {
      if (!schemaReady) {
        await ensureSchema(session, config.embeddingDim);
        schemaReady = true;
      }
      return await fn(session);
    } finally {
      await session.close();
    }
  }

  async function findOrCreateEntity(name: string, embedding: Float32Array): Promise<number> {
    return withSession(async (session) => {
      const query = layer
        ? `MERGE (e:Entity {name: $name, layer: $layer})
           ON CREATE SET e.created_at = datetime(), e.embedding = $emb
           ON MATCH SET e.embedding = $emb
           RETURN id(e) AS id`
        : `MERGE (e:Entity {name: $name})
           ON CREATE SET e.created_at = datetime(), e.embedding = $emb
           ON MATCH SET e.embedding = $emb
           RETURN id(e) AS id`;

      const params: Record<string, unknown> = { name, emb: Array.from(embedding) };
      if (layer) params.layer = layer;

      const result = await session.run(query, params);
      const record = result.records[0];
      return record!.get("id").toNumber();
    });
  }

  async function storeFact(params: StoreFact): Promise<number> {
    return withSession(async (session) => {
      const now = new Date().toISOString();
      const layerProp = layer ? ", layer: $layer" : "";
      const query = `MATCH (subj:Entity) WHERE id(subj) = $subjectId
         MATCH (obj:Entity) WHERE id(obj) = $objectId
         CREATE (f:Fact {
           predicate: $predicate,
           content: $content,
           context: $context,
           source: $source,
           scope_candidate: $scopeCandidate,
           embedding: $embedding,
           created_at: datetime(),
           version: $version,
           valid_from: $validFrom,
           valid_until: $validUntil,
           superseded_by: $supersededBy,
           confidence: $confidence,
           last_validated: $lastValidated${layerProp}
         })
         CREATE (subj)-[:SUBJECT_OF]->(f)
         CREATE (f)-[:OBJECT_IS]->(obj)
         RETURN id(f) AS id, subj.name AS subjectName, obj.name AS objectName`;

      const queryParams: Record<string, unknown> = {
        subjectId: neo4j.int(params.subjectId),
        objectId: neo4j.int(params.objectId),
        predicate: params.predicate,
        content: params.content,
        context: params.context,
        source: params.source,
        scopeCandidate: params.scopeCandidate ?? null,
        embedding: Array.from(params.embedding),
        // v3 fields with defaults
        version: params.version ?? null,
        validFrom: params.validFrom ?? null,
        validUntil: params.validUntil ?? null,
        supersededBy: params.supersededBy ?? null,
        confidence: params.confidence ?? 1.0,
        lastValidated: params.lastValidated ?? now,
      };
      if (layer) queryParams.layer = layer;

      const result = await session.run(query, queryParams);
      const record = result.records[0];
      const factId = record!.get("id").toNumber();

      if (qdrant) {
        try {
          await qdrant.upsertFact({
            id: factId,
            vector: Array.from(params.embedding),
            payload: {
              layer: layer || null,
              subject: record!.get("subjectName") as string,
              predicate: params.predicate,
              object: record!.get("objectName") as string,
              fact: params.content,
              context: params.context,
              source: params.source,
              scope_candidate: params.scopeCandidate || null,
              created_at: now,
              // v3 fields
              version: params.version ?? null,
              valid_from: params.validFrom ?? null,
              valid_until: params.validUntil ?? null,
              superseded_by: params.supersededBy ?? null,
              confidence: params.confidence ?? 1.0,
              last_validated: params.lastValidated ?? now,
            },
          });
        } catch (err) {
          console.error(
            "[claude-memory] WARNING: Qdrant upsert failed:",
            err instanceof Error ? err.message : err
          );
        }
      }

      return factId;
    });
  }

  async function searchFacts(embedding: Float32Array, limit: number): Promise<SearchResult[]> {
    if (qdrant) {
      try {
        const results = await qdrant.searchFacts(
          Array.from(embedding),
          limit,
          layer ? { layer } : undefined
        );
        return results.map((r) => ({
          subject: r.payload.subject,
          predicate: r.payload.predicate,
          object: r.payload.object,
          fact: r.payload.fact,
          context: r.payload.context,
          source: r.payload.source || "",
          score: r.score,
          factId: String(r.id),
          createdAt: r.payload.created_at,
          // v3 fields (normalizePayload already applied defaults)
          version: r.payload.version,
          validFrom: r.payload.valid_from,
          validUntil: r.payload.valid_until,
          supersededBy: r.payload.superseded_by,
          confidence: r.payload.confidence,
          lastValidated: r.payload.last_validated,
        }));
      } catch (err) {
        console.error("[claude-memory] WARNING: Qdrant search failed, falling back to Neo4j:",
          err instanceof Error ? err.message : err);
        // fallthrough to Neo4j
      }
    }

    // Original Neo4j vector search (fallback)
    return withSession(async (session) => {
      // When filtering by layer, request 3x candidates to compensate for post-filter
      const candidateLimit = layer ? limit * 3 : limit;
      const layerFilter = layer ? `WHERE f.layer = $layer` : "";

      const query = `CALL db.index.vector.queryNodes('fact_embedding', $limit, $embedding)
         YIELD node AS f, score
         ${layerFilter}
         MATCH (subj:Entity)-[:SUBJECT_OF]->(f)-[:OBJECT_IS]->(obj:Entity)
         RETURN subj.name AS subject, f.predicate AS predicate, obj.name AS object,
                f.content AS fact, f.context AS context, f.source AS source,
                score, id(f) AS factId
         ORDER BY score DESC`;

      const queryParams: Record<string, unknown> = {
        limit: neo4j.int(candidateLimit),
        embedding: Array.from(embedding),
      };
      if (layer) queryParams.layer = layer;

      const result = await session.run(query, queryParams);

      return result.records.slice(0, limit).map((r) => ({
        subject: r.get("subject") as string,
        predicate: r.get("predicate") as string,
        object: r.get("object") as string,
        fact: r.get("fact") as string,
        context: r.get("context") as string,
        source: (r.get("source") as string) || "",
        score: r.get("score") as number,
        factId: String(r.get("factId").toNumber()),
      }));
    });
  }

  async function searchFactsFiltered(
    embedding: Float32Array,
    limit: number,
    filter: SearchFilter,
  ): Promise<SearchResult[]> {
    if (!qdrant) {
      // Without Qdrant — fallback to regular search (filters ignored)
      return searchFacts(embedding, limit);
    }

    try {
      const qdrantFilter: QdrantFilter = {
        ...(layer ? { layer } : {}),
        ...(filter.predicates ? { predicates: filter.predicates } : {}),
        ...(filter.source ? { source: filter.source } : {}),
        ...(filter.since ? { since: filter.since } : {}),
      };

      const results = await qdrant.searchFacts(Array.from(embedding), limit, qdrantFilter);

      let mapped = results.map((r) => ({
        subject: r.payload.subject,
        predicate: r.payload.predicate,
        object: r.payload.object,
        fact: r.payload.fact,
        context: r.payload.context,
        source: r.payload.source || "",
        score: r.score,
        factId: String(r.id),
        createdAt: r.payload.created_at,
        // v3 fields (normalizePayload already applied defaults)
        version: r.payload.version,
        validFrom: r.payload.valid_from,
        validUntil: r.payload.valid_until,
        supersededBy: r.payload.superseded_by,
        confidence: r.payload.confidence,
        lastValidated: r.payload.last_validated,
      }));

      // Recency bias (client-side blending)
      if (filter.recencyBias && filter.recencyBias > 0) {
        const now = Date.now();
        mapped = mapped.map((r) => {
          const created = r.createdAt ? new Date(r.createdAt).getTime() : now;
          const daysSince = (now - created) / (1000 * 60 * 60 * 24);
          const recencyScore = Math.max(0, 1 - daysSince / 365);
          return {
            ...r,
            score: r.score * (1 - filter.recencyBias!) + recencyScore * filter.recencyBias!,
          };
        }).sort((a, b) => b.score - a.score);
      }

      return mapped;
    } catch (err) {
      console.error("[claude-memory] WARNING: Qdrant filtered search failed, falling back:",
        err instanceof Error ? err.message : err);
      return searchFacts(embedding, limit);
    }
  }

  async function graphTraverse(
    entityName: string,
    depth: number,
    options?: GraphTraverseOptions,
  ): Promise<GraphResult | null> {
    return withSession(async (session) => {
      const includeOutdated = options?.includeOutdated ?? false;

      // Fuzzy find entity
      const layerFilter = layer ? " AND e.layer = $layer" : "";
      const matchQuery = `MATCH (e:Entity)
         WHERE toLower(e.name) CONTAINS toLower($name)${layerFilter}
         RETURN e.name AS name
         ORDER BY size(e.name) ASC
         LIMIT 1`;

      const matchParams: Record<string, unknown> = { name: entityName };
      if (layer) matchParams.layer = layer;

      const matchResult = await session.run(matchQuery, matchParams);

      if (matchResult.records.length === 0) return null;
      const matchedName = matchResult.records[0]!.get("name") as string;

      // Traverse graph — optionally filter superseded facts
      const startFilter = layer ? "{name: $name, layer: $layer}" : "{name: $name}";
      const supersededFilter = includeOutdated
        ? ""
        : `\n         AND ALL(node IN nodes(path) WHERE CASE WHEN node:Fact THEN node.superseded_by IS NULL ELSE true END)`;
      const traverseQuery = `MATCH path = (start:Entity ${startFilter})-[:SUBJECT_OF|OBJECT_IS*1..${depth * 2}]-(connected)
         WHERE (connected:Entity OR connected:Fact)${supersededFilter}
         WITH connected, length(path) AS dist
         ORDER BY dist
         WITH collect(DISTINCT connected) AS nodes
         UNWIND nodes AS n
         OPTIONAL MATCH (s:Entity)-[:SUBJECT_OF]->(n)-[:OBJECT_IS]->(o:Entity) WHERE n:Fact
         RETURN labels(n)[0] AS type, n.name AS entity_name,
                s.name AS subject, n.predicate AS predicate, o.name AS object,
                n.content AS fact, id(n) AS factId,
                n.superseded_by AS superseded_by, n.confidence AS confidence,
                n.last_validated AS last_validated, n.created_at AS created_at`;

      const traverseResult = await session.run(traverseQuery, { name: matchedName, ...(layer ? { layer } : {}) });

      const entities: string[] = [];
      const facts: GraphResult["facts"] = [];

      for (const r of traverseResult.records) {
        const type = r.get("type") as string;
        if (type === "Entity") {
          const eName = r.get("entity_name") as string | null;
          if (eName && eName !== matchedName) entities.push(eName);
        } else if (type === "Fact") {
          const subject = r.get("subject") as string | null;
          if (subject) {
            const supersededBy = r.get("superseded_by") as string | null;
            const rawConfidence = r.get("confidence");
            const confidence = typeof rawConfidence === "number" ? rawConfidence : 1.0;
            const lastValidated = r.get("last_validated") as string | null;
            const createdAtRaw = r.get("created_at");
            const createdAt = createdAtRaw != null ? String(createdAtRaw) : null;

            facts.push({
              subject,
              predicate: r.get("predicate") as string,
              object: r.get("object") as string,
              fact: r.get("fact") as string,
              factId: String(r.get("factId").toNumber()),
              supersededBy,
              confidence,
              lastValidated,
              createdAt,
            });
          }
        }
      }

      return { matchedName, entities, facts };
    });
  }

  async function listEntities(pattern?: string): Promise<EntityInfo[]> {
    return withSession(async (session) => {
      const layerFilter = layer ? " AND e.layer = $layer" : "";

      // Query returns per-fact v3 fields for health score computation
      const query = pattern
        ? `MATCH (e:Entity)
           WHERE toLower(e.name) CONTAINS toLower($pattern)${layerFilter}
           OPTIONAL MATCH (e)-[:SUBJECT_OF]->(f:Fact)
           RETURN e.name AS name,
                  collect({
                    confidence: f.confidence,
                    last_validated: f.last_validated,
                    created_at: f.created_at,
                    superseded_by: f.superseded_by
                  }) AS facts_data
           ORDER BY e.name`
        : `MATCH (e:Entity)
           WHERE 1=1${layerFilter}
           OPTIONAL MATCH (e)-[:SUBJECT_OF]->(f:Fact)
           RETURN e.name AS name,
                  collect({
                    confidence: f.confidence,
                    last_validated: f.last_validated,
                    created_at: f.created_at,
                    superseded_by: f.superseded_by
                  }) AS facts_data
           ORDER BY e.name`;

      const params: Record<string, unknown> = {};
      if (pattern) params.pattern = pattern;
      if (layer) params.layer = layer;

      const result = await session.run(query, params);

      return result.records.map((r) => {
        const name = r.get("name") as string;
        const factsData = r.get("facts_data") as Array<Record<string, unknown>>;

        // Filter out empty entries from OPTIONAL MATCH (when entity has no facts)
        const validFacts = factsData.filter((fd) => fd.confidence !== null || fd.created_at !== null);

        let healthCurrent = 0;
        let healthReview = 0;
        let healthOutdated = 0;

        for (const fd of validFacts) {
          const rawConfidence = fd.confidence;
          const conf = typeof rawConfidence === "number" ? rawConfidence : 1.0;
          const lastValidated = fd.last_validated as string | null;
          const createdAt = fd.created_at != null ? String(fd.created_at) : null;
          const supersededBy = fd.superseded_by as string | null;

          const dc = computeDisplayConfidence({
            confidence: conf,
            last_validated: lastValidated,
            created_at: createdAt,
            superseded_by: supersededBy,
          });

          const tag = confidenceTag(dc);
          if (tag === "\u2705 Current") healthCurrent++;
          else if (tag === "\uD83D\uDD04 Needs review") healthReview++;
          else healthOutdated++;
        }

        return {
          name,
          factCount: validFacts.length,
          healthCurrent,
          healthReview,
          healthOutdated,
        };
      });
    });
  }

  async function getCandidateFacts(scope: "global" | "project"): Promise<CandidateFact[]> {
    return withSession(async (session) => {
      const layerFilter = layer ? " AND f.layer = $layer" : "";

      const result = await session.run(
        `MATCH (subj:Entity)-[:SUBJECT_OF]->(f:Fact)-[:OBJECT_IS]->(obj:Entity)
         WHERE f.scope_candidate = $scope${layerFilter}
         RETURN id(f) AS factId, subj.name AS subject, f.predicate AS predicate,
                obj.name AS object, f.content AS content, f.context AS context,
                f.source AS source, f.scope_candidate AS scopeCandidate
         ORDER BY f.created_at DESC`,
        { scope, ...(layer ? { layer } : {}) },
      );
      return result.records.map((r) => ({
        factId: r.get("factId").toNumber(),
        subject: r.get("subject") as string,
        predicate: r.get("predicate") as string,
        object: r.get("object") as string,
        content: r.get("content") as string,
        context: r.get("context") as string,
        source: (r.get("source") as string) || "",
        scopeCandidate: r.get("scopeCandidate") as "global" | "project",
      }));
    });
  }

  async function updateFactScope(factId: number, scope: "global" | "project" | null): Promise<void> {
    await withSession(async (session) => {
      await session.run(
        `MATCH (f:Fact) WHERE id(f) = $factId
         SET f.scope_candidate = $scope`,
        { factId: neo4j.int(factId), scope },
      );
    });
  }

  async function deleteFact(factId: number): Promise<boolean> {
    return withSession(async (session) => {
      const layerFilter = layer ? " AND f.layer = $layer" : "";
      const result = await session.run(
        `MATCH (f:Fact) WHERE id(f) = $factId${layerFilter}
         DETACH DELETE f
         RETURN count(f) AS deleted`,
        { factId: neo4j.int(factId), ...(layer ? { layer } : {}) },
      );
      const deleted = result.records[0]?.get("deleted")?.toNumber() ?? 0;

      if (qdrant && deleted > 0) {
        try {
          await qdrant.deleteFact(factId);
        } catch (err) {
          console.error(
            "[claude-memory] WARNING: Qdrant delete failed:",
            err instanceof Error ? err.message : err
          );
        }
      }

      return deleted > 0;
    });
  }

  async function findDependentFacts(factId: number): Promise<number[]> {
    return withSession(async (session) => {
      const layerFilter = layer ? " AND f.layer = $layer" : "";
      const result = await session.run(
        `MATCH (f:Fact) WHERE f.superseded_by = $factId${layerFilter}
         RETURN id(f) AS depId`,
        { factId: neo4j.int(factId), ...(layer ? { layer } : {}) },
      );
      return result.records.map((r) => r.get("depId").toNumber());
    });
  }

  async function clearSupersededBy(factIds: number[]): Promise<number> {
    if (factIds.length === 0) return 0;
    return withSession(async (session) => {
      const result = await session.run(
        `UNWIND $factIds AS fid
         MATCH (f:Fact) WHERE id(f) = fid
         SET f.superseded_by = null
         RETURN count(f) AS cleared`,
        { factIds: factIds.map((id) => neo4j.int(id)) },
      );
      return result.records[0]?.get("cleared")?.toNumber() ?? 0;
    });
  }

  async function queryFactsForValidation(opts: {
    subject?: string;
    source?: string;
    maxAgeDays?: number;
    limit: number;
  }): Promise<ValidatableFact[]> {
    return withSession(async (session) => {
      const conditions: string[] = [];
      const params: Record<string, unknown> = {};

      if (layer) {
        conditions.push("f.layer = $layer");
        params.layer = layer;
      }

      // Only current facts (not superseded)
      conditions.push("(f.superseded_by IS NULL)");

      if (opts.subject) {
        conditions.push("toLower(subj.name) CONTAINS toLower($subject)");
        params.subject = opts.subject;
      }

      if (opts.source) {
        conditions.push("f.source = $source");
        params.source = opts.source;
      }

      if (opts.maxAgeDays !== undefined) {
        conditions.push(
          "(f.last_validated IS NULL OR f.last_validated < datetime() - duration({days: $maxAgeDays}))"
        );
        params.maxAgeDays = neo4j.int(opts.maxAgeDays);
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
      params.limit = neo4j.int(opts.limit);

      const result = await session.run(
        `MATCH (subj:Entity)-[:SUBJECT_OF]->(f:Fact)-[:OBJECT_IS]->(obj:Entity)
         ${where}
         RETURN id(f) AS factId, subj.name AS subject, f.predicate AS predicate,
                obj.name AS object, f.content AS content, f.source AS source,
                coalesce(f.confidence, 1.0) AS confidence,
                toString(f.last_validated) AS lastValidated
         ORDER BY coalesce(f.last_validated, datetime('1970-01-01T00:00:00Z')) ASC
         LIMIT $limit`,
        params,
      );

      return result.records.map((r) => ({
        factId: r.get("factId").toNumber(),
        subject: r.get("subject") as string,
        predicate: r.get("predicate") as string,
        object: r.get("object") as string,
        content: r.get("content") as string,
        source: (r.get("source") as string) || "",
        confidence: r.get("confidence") as number,
        lastValidated: r.get("lastValidated") as string | null,
      }));
    });
  }

  async function updateFactValidation(
    factId: number,
    updates: { confidence?: number; lastValidated?: string },
  ): Promise<void> {
    await withSession(async (session) => {
      const setClauses: string[] = [];
      const params: Record<string, unknown> = { factId: neo4j.int(factId) };

      if (updates.confidence !== undefined) {
        setClauses.push("f.confidence = $confidence");
        params.confidence = updates.confidence;
      }
      if (updates.lastValidated !== undefined) {
        setClauses.push("f.last_validated = datetime($lastValidated)");
        params.lastValidated = updates.lastValidated;
      }

      if (setClauses.length === 0) return;

      await session.run(
        `MATCH (f:Fact) WHERE id(f) = $factId
         SET ${setClauses.join(", ")}`,
        params,
      );
    });
  }

  async function close(): Promise<void> {
    await driver.close();
  }

  return {
    findOrCreateEntity,
    storeFact,
    searchFacts,
    graphTraverse,
    listEntities,
    deleteFact,
    getCandidateFacts,
    updateFactScope,
    searchFactsFiltered: qdrant ? searchFactsFiltered : undefined,
    findDependentFacts,
    clearSupersededBy,
    queryFactsForValidation,
    updateFactValidation,
    close,
  };
}
