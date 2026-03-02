import { existsSync } from "node:fs";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { getConfig } from "./config.js";
import type {
  StoreFact,
  SearchResult,
  GraphResult,
  EntityInfo,
  CandidateFact,
  StorageBackend,
} from "./types.js";

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS entities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS facts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    subject_id INTEGER NOT NULL REFERENCES entities(id),
    predicate TEXT NOT NULL,
    object_id INTEGER NOT NULL REFERENCES entities(id),
    content TEXT NOT NULL,
    context TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_facts_subject ON facts(subject_id);
  CREATE INDEX IF NOT EXISTS idx_facts_object ON facts(object_id);

  CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`;

/** Convert Float32Array to Buffer for sqlite-vec binding */
function vecBuf(v: Float32Array): Buffer {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}

export interface Db {
  findOrCreateEntity(name: string, embedding: Float32Array): number;
  storeFact(params: StoreFact): number;
  searchFacts(embedding: Float32Array, limit: number): SearchResult[];
  graphTraverse(entityName: string, depth: number): GraphResult | null;
  listEntities(pattern?: string): EntityInfo[];
  getCandidateFacts(scope: "global" | "project"): CandidateFact[];
  updateFactScope(factId: number, scope: "global" | "project" | null): void;
  close(): void;
}

export function initDb(dbPathOverride?: string): Db {
  const config = getConfig();
  const db = new Database(dbPathOverride ?? config.dbPath);

  sqliteVec.load(db);

  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(SCHEMA_SQL);

  // Migration: add scope_candidate column if missing
  try {
    db.exec("ALTER TABLE facts ADD COLUMN scope_candidate TEXT DEFAULT NULL");
  } catch {
    // column already exists
  }

  // Validate embedding dimension against stored metadata
  const storedDim = db
    .prepare("SELECT value FROM meta WHERE key = 'embedding_dim'")
    .get() as { value: string } | undefined;

  if (storedDim) {
    const existing = parseInt(storedDim.value, 10);
    if (existing !== config.embeddingDim) {
      const entityCount = (db.prepare("SELECT COUNT(*) as c FROM entities").get() as { c: number }).c;
      const factCount = (db.prepare("SELECT COUNT(*) as c FROM facts").get() as { c: number }).c;

      if (entityCount === 0 && factCount === 0) {
        // Empty DB — safe to auto-migrate
        console.error(
          `[claude-memory] Auto-migrating empty DB: dim ${existing} → ${config.embeddingDim}`
        );
        db.exec("DROP TABLE IF EXISTS fact_embeddings");
        db.exec("DROP TABLE IF EXISTS entity_embeddings");
        db.prepare("UPDATE meta SET value = ? WHERE key = 'embedding_dim'")
          .run(String(config.embeddingDim));
      } else {
        throw new Error(
          `Embedding dimension mismatch: database has ${entityCount} entities and ${factCount} facts ` +
          `with dim=${existing}, but current config has dim=${config.embeddingDim}. ` +
          `Run 'npx semantic-memory-mcp init' to migrate, or use EMBEDDING_DIM=${existing}.`
        );
      }
    }
  } else {
    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('embedding_dim', ?)")
      .run(String(config.embeddingDim));
  }

  // vec0 virtual tables use rowid (no explicit PK column)
  try {
    db.exec(`
      CREATE VIRTUAL TABLE entity_embeddings USING vec0(
        embedding float[${config.embeddingDim}] distance_metric=cosine
      );
    `);
  } catch {
    // already exists
  }

  try {
    db.exec(`
      CREATE VIRTUAL TABLE fact_embeddings USING vec0(
        embedding float[${config.embeddingDim}] distance_metric=cosine
      );
    `);
  } catch {
    // already exists
  }

  // Prepared statements
  const insertEntity = db.prepare(
    "INSERT OR IGNORE INTO entities (name) VALUES (?)"
  );
  const selectEntityId = db.prepare(
    "SELECT id FROM entities WHERE name = ?"
  );
  const deleteEntityEmbedding = db.prepare(
    "DELETE FROM entity_embeddings WHERE rowid = ?"
  );
  const insertEntityEmbedding = db.prepare(
    "INSERT INTO entity_embeddings (rowid, embedding) VALUES (?, ?)"
  );
  const insertFact = db.prepare(
    `INSERT INTO facts (subject_id, predicate, object_id, content, context, source, scope_candidate)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  const insertFactEmbedding = db.prepare(
    "INSERT INTO fact_embeddings (rowid, embedding) VALUES (?, ?)"
  );
  const knnSearch = db.prepare(`
    WITH knn AS (
      SELECT rowid, distance
      FROM fact_embeddings
      WHERE embedding MATCH ?
        AND k = ?
    )
    SELECT
      e_subj.name AS subject,
      f.predicate,
      e_obj.name AS object,
      f.content AS fact,
      f.context,
      f.source,
      (1.0 - knn.distance) AS score
    FROM knn
    JOIN facts f ON f.id = knn.rowid
    JOIN entities e_subj ON e_subj.id = f.subject_id
    JOIN entities e_obj ON e_obj.id = f.object_id
    ORDER BY knn.distance ASC
  `);
  const fuzzyFindEntity = db.prepare(`
    SELECT id, name FROM entities
    WHERE LOWER(name) LIKE '%' || LOWER(?) || '%'
    ORDER BY LENGTH(name) ASC
    LIMIT 1
  `);
  const listEntitiesAll = db.prepare(`
    SELECT e.name, COUNT(f.id) AS fact_count
    FROM entities e
    LEFT JOIN facts f ON f.subject_id = e.id
    GROUP BY e.id
    ORDER BY e.name
  `);
  const listEntitiesFiltered = db.prepare(`
    SELECT e.name, COUNT(f.id) AS fact_count
    FROM entities e
    LEFT JOIN facts f ON f.subject_id = e.id
    WHERE LOWER(e.name) LIKE '%' || LOWER(?) || '%'
    GROUP BY e.id
    ORDER BY e.name
  `);

  function findOrCreateEntity(name: string, embedding: Float32Array): number {
    insertEntity.run(name);
    const row = selectEntityId.get(name) as { id: number | bigint };
    const id = Number(row.id);
    // Upsert embedding: delete then insert (vec0 doesn't support OR REPLACE)
    deleteEntityEmbedding.run(BigInt(id));
    insertEntityEmbedding.run(BigInt(id), vecBuf(embedding));
    return id;
  }

  function storeFact(params: StoreFact): number {
    const result = insertFact.run(
      params.subjectId,
      params.predicate,
      params.objectId,
      params.content,
      params.context,
      params.source,
      params.scopeCandidate ?? null
    );
    const factId = Number(result.lastInsertRowid);
    insertFactEmbedding.run(BigInt(factId), vecBuf(params.embedding));
    return factId;
  }

  function searchFacts(embedding: Float32Array, limit: number): SearchResult[] {
    return knnSearch.all(vecBuf(embedding), limit) as SearchResult[];
  }

  function graphTraverse(entityName: string, depth: number): GraphResult | null {
    const match = fuzzyFindEntity.get(entityName) as
      | { id: number | bigint; name: string }
      | undefined;
    if (!match) return null;

    const startId = Number(match.id);

    // Recursive CTE to find connected entity IDs
    const traverseStmt = db.prepare(`
      WITH RECURSIVE graph(entity_id, depth) AS (
        SELECT ?, 0
        UNION
        SELECT f.object_id, g.depth + 1
        FROM graph g
        JOIN facts f ON f.subject_id = g.entity_id
        WHERE g.depth < ?
        UNION
        SELECT f.subject_id, g.depth + 1
        FROM graph g
        JOIN facts f ON f.object_id = g.entity_id
        WHERE g.depth < ?
      )
      SELECT DISTINCT e.name
      FROM graph g
      JOIN entities e ON e.id = g.entity_id
      WHERE g.entity_id != ?
    `);

    const entityRows = traverseStmt.all(startId, depth, depth, startId) as Array<{
      name: string;
    }>;

    // Get all facts connecting found entities
    const allNames = [match.name, ...entityRows.map((r) => r.name)];
    const placeholders = allNames.map(() => "?").join(",");
    const factsStmt = db.prepare(`
      SELECT
        e_subj.name AS subject,
        f.predicate,
        e_obj.name AS object,
        f.content AS fact
      FROM facts f
      JOIN entities e_subj ON e_subj.id = f.subject_id
      JOIN entities e_obj ON e_obj.id = f.object_id
      WHERE e_subj.name IN (${placeholders}) OR e_obj.name IN (${placeholders})
      ORDER BY f.created_at DESC
    `);

    const factRows = factsStmt.all(...allNames, ...allNames) as Array<{
      subject: string;
      predicate: string;
      object: string;
      fact: string;
    }>;

    return {
      matchedName: match.name,
      entities: entityRows.map((r) => r.name),
      facts: factRows,
    };
  }

  function listEntities(pattern?: string): EntityInfo[] {
    const rows = pattern
      ? (listEntitiesFiltered.all(pattern) as Array<{
          name: string;
          fact_count: number;
        }>)
      : (listEntitiesAll.all() as Array<{ name: string; fact_count: number }>);

    return rows.map((r) => ({ name: r.name, factCount: r.fact_count }));
  }

  // Candidate facts queries
  const selectCandidates = db.prepare(`
    SELECT
      f.id AS factId,
      e_subj.name AS subject,
      f.predicate,
      e_obj.name AS object,
      f.content,
      f.context,
      f.source,
      f.scope_candidate AS scopeCandidate
    FROM facts f
    JOIN entities e_subj ON e_subj.id = f.subject_id
    JOIN entities e_obj ON e_obj.id = f.object_id
    WHERE f.scope_candidate = ?
    ORDER BY f.created_at DESC
  `);

  const updateScope = db.prepare(
    "UPDATE facts SET scope_candidate = ? WHERE id = ?"
  );

  function getCandidateFacts(scope: "global" | "project"): CandidateFact[] {
    return selectCandidates.all(scope) as CandidateFact[];
  }

  function updateFactScope(factId: number, scope: "global" | "project" | null): void {
    updateScope.run(scope, factId);
  }

  return {
    findOrCreateEntity,
    storeFact,
    searchFacts,
    graphTraverse,
    listEntities,
    getCandidateFacts,
    updateFactScope,
    close: () => db.close(),
  };
}

// ─── Standalone migration for use by init ────────────────────

export interface MigrateResult {
  status: "no_db" | "match" | "migrated";
  oldDim?: number;
  droppedEntities?: number;
  droppedFacts?: number;
}

export function migrateEmbeddingDim(dbPath: string, newDim: number): MigrateResult {
  if (!existsSync(dbPath)) return { status: "no_db" };

  const db = new Database(dbPath);
  sqliteVec.load(db);

  try {
    const hasMeta = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='meta'"
    ).get();
    if (!hasMeta) return { status: "no_db" };

    const row = db.prepare(
      "SELECT value FROM meta WHERE key = 'embedding_dim'"
    ).get() as { value: string } | undefined;
    if (!row) return { status: "no_db" };

    const oldDim = parseInt(row.value, 10);
    if (oldDim === newDim) return { status: "match" };

    // Count existing data
    const entities = (db.prepare("SELECT COUNT(*) as c FROM entities").get() as { c: number }).c;
    const facts = (db.prepare("SELECT COUNT(*) as c FROM facts").get() as { c: number }).c;

    // Drop vec0 tables (embeddings are invalidated by dimension change)
    db.exec("DROP TABLE IF EXISTS fact_embeddings");
    db.exec("DROP TABLE IF EXISTS entity_embeddings");

    if (entities > 0 || facts > 0) {
      db.exec("DELETE FROM facts");
      db.exec("DELETE FROM entities");
    }

    // Update dimension and recreate vec0 tables
    db.prepare("UPDATE meta SET value = ? WHERE key = 'embedding_dim'")
      .run(String(newDim));

    db.exec(`CREATE VIRTUAL TABLE entity_embeddings USING vec0(
      embedding float[${newDim}] distance_metric=cosine
    )`);
    db.exec(`CREATE VIRTUAL TABLE fact_embeddings USING vec0(
      embedding float[${newDim}] distance_metric=cosine
    )`);

    return { status: "migrated", oldDim, droppedEntities: entities, droppedFacts: facts };
  } finally {
    db.close();
  }
}

/** Wraps sync SQLite Db into async StorageBackend */
export function sqliteBackend(db: Db): StorageBackend {
  return {
    findOrCreateEntity: async (name, embedding) => db.findOrCreateEntity(name, embedding),
    storeFact: async (params) => db.storeFact(params),
    searchFacts: async (embedding, limit) => db.searchFacts(embedding, limit),
    graphTraverse: async (entityName, depth) => db.graphTraverse(entityName, depth),
    listEntities: async (pattern) => db.listEntities(pattern),
    getCandidateFacts: async (scope) => db.getCandidateFacts(scope),
    updateFactScope: async (factId, scope) => db.updateFactScope(factId, scope),
    close: async () => db.close(),
  };
}
