import { classifyScope } from "./classify.js";
import type {
  StorageBackend,
  DualStorageBackend,
  StoreFact,
  SearchResult,
  GraphResult,
  EntityInfo,
  CandidateFact,
} from "./types.js";

/**
 * Composite backend that auto-routes writes by predicate scope and reads from both layers.
 * Global predicates (uses, depends_on, etc.) write directly to global layer.
 * Project predicates (bug_in, todo, etc.) write to project layer.
 */
export function createDualBackend(
  project: StorageBackend,
  global: StorageBackend,
): DualStorageBackend {
  function getLayerBackend(scope: "global" | "project"): StorageBackend {
    return scope === "global" ? global : project;
  }

  async function findOrCreateEntity(name: string, embedding: Float32Array): Promise<number> {
    return project.findOrCreateEntity(name, embedding);
  }

  async function storeFact(params: StoreFact): Promise<number> {
    const scope = params.scopeCandidate ?? classifyScope(params.predicate);
    const target = getLayerBackend(scope);
    return target.storeFact({ ...params, scopeCandidate: scope });
  }

  async function searchFacts(embedding: Float32Array, limit: number): Promise<SearchResult[]> {
    const [projectResults, globalResults] = await Promise.all([
      project.searchFacts(embedding, limit),
      global.searchFacts(embedding, limit),
    ]);

    // Tag source layer
    for (const r of projectResults) r.sourceLayer = "project";
    for (const r of globalResults) r.sourceLayer = "global";

    // Merge and deduplicate by subject|predicate|object
    const seen = new Set<string>();
    const merged: SearchResult[] = [];

    const all = [...projectResults, ...globalResults].sort((a, b) => b.score - a.score);
    for (const r of all) {
      const key = `${r.subject}|${r.predicate}|${r.object}`;
      if (!seen.has(key)) {
        seen.add(key);
        merged.push(r);
      }
    }

    return merged.slice(0, limit);
  }

  async function graphTraverse(entityName: string, depth: number): Promise<GraphResult | null> {
    const [projectResult, globalResult] = await Promise.all([
      project.graphTraverse(entityName, depth),
      global.graphTraverse(entityName, depth),
    ]);

    if (!projectResult && !globalResult) return null;
    if (!projectResult) return globalResult;
    if (!globalResult) return projectResult;

    // Merge entities (deduplicate)
    const entitySet = new Set([...projectResult.entities, ...globalResult.entities]);

    // Merge facts (deduplicate by subject|predicate|object)
    const factMap = new Map<string, GraphResult["facts"][number]>();
    for (const f of [...projectResult.facts, ...globalResult.facts]) {
      const key = `${f.subject}|${f.predicate}|${f.object}`;
      if (!factMap.has(key)) factMap.set(key, f);
    }

    return {
      matchedName: projectResult.matchedName,
      entities: [...entitySet],
      facts: [...factMap.values()],
    };
  }

  async function listEntities(pattern?: string): Promise<EntityInfo[]> {
    const [projectEntities, globalEntities] = await Promise.all([
      project.listEntities(pattern),
      global.listEntities(pattern),
    ]);

    // Merge by name, sum factCounts
    const map = new Map<string, number>();
    for (const e of projectEntities) {
      map.set(e.name, (map.get(e.name) ?? 0) + e.factCount);
    }
    for (const e of globalEntities) {
      map.set(e.name, (map.get(e.name) ?? 0) + e.factCount);
    }

    return [...map.entries()]
      .map(([name, factCount]) => ({ name, factCount }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async function getCandidateFacts(scope: "global" | "project"): Promise<CandidateFact[]> {
    if (project.getCandidateFacts) {
      return project.getCandidateFacts(scope);
    }
    return [];
  }

  async function updateFactScope(factId: number, scope: "global" | "project" | null): Promise<void> {
    if (project.updateFactScope) {
      await project.updateFactScope(factId, scope);
    }
  }

  async function close(): Promise<void> {
    await Promise.all([project.close(), global.close()]);
  }

  return {
    isDual: true as const,
    getLayerBackend,
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
