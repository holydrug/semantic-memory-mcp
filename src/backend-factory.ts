import type { Config } from "./config.js";
import type { StorageBackend } from "./types.js";
import { initNeo4j } from "./neo4j.js";
import { initQdrant, type QdrantBackend } from "./qdrant.js";

let sharedQdrant: QdrantBackend | undefined;
let backendTypeLogged = false;

/**
 * Create a StorageBackend for the given layer.
 * - "project" uses the project-level config (projectSlug as layer)
 * - "global" uses "global" as layer
 * Initializes shared Qdrant backend on first call if QDRANT_URL is set.
 */
export async function createBackend(config: Config, layer: "project" | "global"): Promise<StorageBackend> {
  const layerParam = config.dualMode
    ? (layer === "global" ? layer : config.projectSlug)
    : undefined;

  if (config.qdrantUrl && !sharedQdrant) {
    try {
      sharedQdrant = initQdrant(config.qdrantUrl, config.qdrantCollection, config.qdrantApiKey);
      await sharedQdrant.ensureCollection(config.embeddingDim);
      console.error("[claude-memory] Using Neo4j + Qdrant storage backend");
      backendTypeLogged = true;
    } catch (err) {
      console.error("[claude-memory] WARNING: Qdrant unavailable, falling back to Neo4j:",
        err instanceof Error ? err.message : err);
      sharedQdrant = undefined;
    }
  }

  if (!backendTypeLogged && !sharedQdrant) {
    console.error("[claude-memory] Using Neo4j storage backend");
    backendTypeLogged = true;
  }

  return initNeo4j(layerParam, sharedQdrant);
}
