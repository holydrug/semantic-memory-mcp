import neo4j, { type Driver, type Session } from "neo4j-driver";
import { getConfig } from "./config.js";
import type {
  StoreFact,
  SearchResult,
  GraphResult,
  EntityInfo,
  CandidateFact,
  StorageBackend,
} from "./types.js";

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

export function initNeo4j(layer?: string): StorageBackend {
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
           created_at: datetime()${layerProp}
         })
         CREATE (subj)-[:SUBJECT_OF]->(f)
         CREATE (f)-[:OBJECT_IS]->(obj)
         RETURN id(f) AS id`;

      const queryParams: Record<string, unknown> = {
        subjectId: neo4j.int(params.subjectId),
        objectId: neo4j.int(params.objectId),
        predicate: params.predicate,
        content: params.content,
        context: params.context,
        source: params.source,
        scopeCandidate: params.scopeCandidate ?? null,
        embedding: Array.from(params.embedding),
      };
      if (layer) queryParams.layer = layer;

      const result = await session.run(query, queryParams);
      const record = result.records[0];
      return record!.get("id").toNumber();
    });
  }

  async function searchFacts(embedding: Float32Array, limit: number): Promise<SearchResult[]> {
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
                score
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
      }));
    });
  }

  async function graphTraverse(
    entityName: string,
    depth: number,
  ): Promise<GraphResult | null> {
    return withSession(async (session) => {
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

      // Traverse graph
      const startFilter = layer ? "{name: $name, layer: $layer}" : "{name: $name}";
      const traverseQuery = `MATCH path = (start:Entity ${startFilter})-[:SUBJECT_OF|OBJECT_IS*1..${depth * 2}]-(connected)
         WHERE connected:Entity OR connected:Fact
         WITH connected, length(path) AS dist
         ORDER BY dist
         WITH collect(DISTINCT connected) AS nodes
         UNWIND nodes AS n
         OPTIONAL MATCH (s:Entity)-[:SUBJECT_OF]->(n)-[:OBJECT_IS]->(o:Entity) WHERE n:Fact
         RETURN labels(n)[0] AS type, n.name AS entity_name,
                s.name AS subject, n.predicate AS predicate, o.name AS object,
                n.content AS fact`;

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
            facts.push({
              subject,
              predicate: r.get("predicate") as string,
              object: r.get("object") as string,
              fact: r.get("fact") as string,
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

      const query = pattern
        ? `MATCH (e:Entity)
           WHERE toLower(e.name) CONTAINS toLower($pattern)${layerFilter}
           OPTIONAL MATCH (e)-[:SUBJECT_OF]->(f:Fact)
           RETURN e.name AS name, count(f) AS fact_count
           ORDER BY e.name`
        : `MATCH (e:Entity)
           WHERE 1=1${layerFilter}
           OPTIONAL MATCH (e)-[:SUBJECT_OF]->(f:Fact)
           RETURN e.name AS name, count(f) AS fact_count
           ORDER BY e.name`;

      const params: Record<string, unknown> = {};
      if (pattern) params.pattern = pattern;
      if (layer) params.layer = layer;

      const result = await session.run(query, params);

      return result.records.map((r) => ({
        name: r.get("name") as string,
        factCount: (r.get("fact_count") as neo4j.Integer).toNumber(),
      }));
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

  async function close(): Promise<void> {
    await driver.close();
  }

  return {
    findOrCreateEntity,
    storeFact,
    searchFacts,
    graphTraverse,
    listEntities,
    getCandidateFacts,
    updateFactScope,
    close,
  };
}
