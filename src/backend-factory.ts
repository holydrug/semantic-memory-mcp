import type { Config } from "./config.js";
import type { StorageBackend } from "./types.js";
import { initNeo4j } from "./neo4j.js";

/**
 * Create a StorageBackend for the given layer.
 * - "project" uses the project-level config (projectSlug as layer)
 * - "global" uses "global" as layer
 */
export function createBackend(config: Config, layer: "project" | "global"): StorageBackend {
  const layerParam = config.dualMode
    ? (layer === "global" ? layer : config.projectSlug)
    : undefined;
  return initNeo4j(layerParam);
}
