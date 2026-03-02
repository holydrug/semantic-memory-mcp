import type { Config } from "./config.js";
import type { StorageBackend } from "./types.js";
import { initDb, sqliteBackend } from "./db.js";
import { initNeo4j } from "./neo4j.js";

/**
 * Create a StorageBackend for the given layer.
 * - "project" uses the project-level config (dbPath, storageProvider)
 * - "global" uses globalDbPath / globalStorageProvider
 */
export function createBackend(config: Config, layer: "project" | "global"): StorageBackend {
  if (layer === "global") {
    if (config.globalStorageProvider === "neo4j") {
      return initNeo4j(config.dualMode ? layer : undefined);
    }
    return sqliteBackend(initDb(config.globalDbPath));
  }

  // project layer
  if (config.storageProvider === "neo4j") {
    return initNeo4j(config.dualMode ? config.projectSlug : undefined);
  }
  return sqliteBackend(initDb());
}
