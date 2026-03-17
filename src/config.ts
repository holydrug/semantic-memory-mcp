import { homedir } from "node:os";
import { basename, join } from "node:path";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import type { ConfigV3 } from "./types.js";

export interface ValidationConfig {
  mode: "on-store" | "off";
  claudePath: string;
  model: string;
  conflictThreshold: number;
  sweepCooldownMin: number;
  sweepBatchSize: number;
  maxFactAgeDays: number;
  maxValidationsPerMinute: number;
}

export interface Config {
  modelCacheDir: string;
  embeddingProvider: "builtin" | "ollama";
  embeddingModel: string;
  embeddingDim: number;
  ollamaUrl: string;
  ollamaModel: string;
  neo4jUri: string;
  neo4jUser: string;
  neo4jPassword: string;
  triggersStore?: string;
  triggersSearch?: string;
  triggersGraph?: string;
  triggersList?: string;
  triggersDelete?: string;
  triggersValidate?: string;
  dualMode: boolean;
  globalDir: string;
  projectSlug: string;
  qdrantUrl?: string;
  qdrantApiKey?: string;
  qdrantCollection: string;
  validation: ValidationConfig;
}

const DEFAULT_DIM = {
  builtin: 384,
  ollama: 768,
} as const;

/** Default values for optional validation fields */
const VALIDATION_DEFAULTS: ConfigV3["validation"] = {
  mode: "on-store",
  claudePath: "claude",
  model: "sonnet",
  conflictThreshold: 0.85,
  sweepCooldownMin: 30,
  sweepBatchSize: 20,
  maxFactAgeDays: 90,
  maxValidationsPerMinute: 10,
};

/** Default values for optional ingest fields */
const INGEST_DEFAULTS: ConfigV3["ingest"] = {
  batchSize: 5,
  model: "sonnet",
};

/** Default values for optional layers fields */
const LAYERS_DEFAULTS: ConfigV3["layers"] = {
  mode: "auto",
  globalDir: null,
};

/**
 * Resolve config in order:
 * 1. SEMANTIC_MEMORY_CONFIG env var -> read that path
 * 2. ~/.semantic-memory/config.json -> global config (standard location)
 * 3. Env vars fallback -> backward compat with v2
 */
export function getConfig(): Config {
  // 1. Explicit config path (v3 -- set by init in .claude.json)
  const configPath = process.env["SEMANTIC_MEMORY_CONFIG"];
  if (configPath) {
    if (!existsSync(configPath)) {
      throw new Error(
        `Config file not found at SEMANTIC_MEMORY_CONFIG="${configPath}". ` +
        `Run 'npx semantic-memory-mcp init' to create it.`
      );
    }
    return parseConfigJson(configPath);
  }

  // 2. Standard location
  const homeConfig = join(homedir(), ".semantic-memory", "config.json");
  if (existsSync(homeConfig)) {
    return parseConfigJson(homeConfig);
  }

  // 3. Env vars fallback (v2 backward compat)
  return getConfigFromEnv();
}

/**
 * Parse and validate config.json, return the runtime Config shape.
 * Exported for testing.
 */
export function parseConfigJson(filePath: string): Config {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch (err) {
    throw new Error(
      `Cannot read config file "${filePath}": ${err instanceof Error ? err.message : err}`
    );
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error(
      `Invalid JSON in config file "${filePath}". Check syntax with a JSON validator.`
    );
  }

  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    throw new Error(
      `Config file "${filePath}" must contain a JSON object.`
    );
  }

  const obj = json as Record<string, unknown>;

  // Validate required top-level fields
  validateRequired(obj, "version", "number", filePath);
  if (obj["version"] !== 3) {
    throw new Error(
      `Unsupported config version ${String(obj["version"])} in "${filePath}". Expected: 3.`
    );
  }

  validateRequired(obj, "dataDir", "string", filePath);
  const dataDir = obj["dataDir"] as string;

  // neo4j section
  if (!obj["neo4j"] || typeof obj["neo4j"] !== "object") {
    throw new Error(`Missing required field "neo4j" in "${filePath}".`);
  }
  const neo4jObj = obj["neo4j"] as Record<string, unknown>;
  validateRequired(neo4jObj, "uri", "string", filePath, "neo4j.");
  validateRequired(neo4jObj, "user", "string", filePath, "neo4j.");
  validateRequired(neo4jObj, "password", "string", filePath, "neo4j.");

  // qdrant section
  if (!obj["qdrant"] || typeof obj["qdrant"] !== "object") {
    throw new Error(`Missing required field "qdrant" in "${filePath}".`);
  }
  const qdrantObj = obj["qdrant"] as Record<string, unknown>;
  validateRequired(qdrantObj, "url", "string", filePath, "qdrant.");
  validateRequired(qdrantObj, "collection", "string", filePath, "qdrant.");

  // embeddings section
  if (!obj["embeddings"] || typeof obj["embeddings"] !== "object") {
    throw new Error(`Missing required field "embeddings" in "${filePath}".`);
  }
  const embObj = obj["embeddings"] as Record<string, unknown>;
  validateRequired(embObj, "provider", "string", filePath, "embeddings.");
  validateRequired(embObj, "model", "string", filePath, "embeddings.");
  validateRequired(embObj, "dimension", "number", filePath, "embeddings.");

  const provider = embObj["provider"] as string;
  if (provider !== "builtin" && provider !== "ollama") {
    throw new Error(
      `Invalid embeddings.provider "${provider}" in "${filePath}". Supported: builtin, ollama.`
    );
  }

  // Optional sections with defaults (validate shape for later steps)
  const validationRaw = (obj["validation"] && typeof obj["validation"] === "object")
    ? obj["validation"] as Record<string, unknown>
    : {};
  // Parse and apply defaults (validated shape for later steps)
  const _validation: ConfigV3["validation"] = {
    mode: validationRaw["mode"] === "off" ? "off" : (validationRaw["mode"] === "on-store" ? "on-store" : VALIDATION_DEFAULTS.mode),
    claudePath: typeof validationRaw["claudePath"] === "string" ? validationRaw["claudePath"] : VALIDATION_DEFAULTS.claudePath,
    model: typeof validationRaw["model"] === "string" ? validationRaw["model"] : VALIDATION_DEFAULTS.model,
    conflictThreshold: typeof validationRaw["conflictThreshold"] === "number" ? validationRaw["conflictThreshold"] : VALIDATION_DEFAULTS.conflictThreshold,
    sweepCooldownMin: typeof validationRaw["sweepCooldownMin"] === "number" ? validationRaw["sweepCooldownMin"] : VALIDATION_DEFAULTS.sweepCooldownMin,
    sweepBatchSize: typeof validationRaw["sweepBatchSize"] === "number" ? validationRaw["sweepBatchSize"] : VALIDATION_DEFAULTS.sweepBatchSize,
    maxFactAgeDays: typeof validationRaw["maxFactAgeDays"] === "number" ? validationRaw["maxFactAgeDays"] : VALIDATION_DEFAULTS.maxFactAgeDays,
    maxValidationsPerMinute: typeof validationRaw["maxValidationsPerMinute"] === "number" ? validationRaw["maxValidationsPerMinute"] : VALIDATION_DEFAULTS.maxValidationsPerMinute,
  };
  const validation = _validation;

  const ingestRaw = (obj["ingest"] && typeof obj["ingest"] === "object")
    ? obj["ingest"] as Record<string, unknown>
    : {};
  const _ingest: ConfigV3["ingest"] = {
    batchSize: typeof ingestRaw["batchSize"] === "number" ? ingestRaw["batchSize"] : INGEST_DEFAULTS.batchSize,
    model: typeof ingestRaw["model"] === "string" ? ingestRaw["model"] : INGEST_DEFAULTS.model,
  };
  void _ingest; // will be used in later steps

  const layersRaw = (obj["layers"] && typeof obj["layers"] === "object")
    ? obj["layers"] as Record<string, unknown>
    : {};
  const layersMode = layersRaw["mode"] === "off" ? "off" as const : (layersRaw["mode"] === "auto" ? "auto" as const : LAYERS_DEFAULTS.mode);
  const layersGlobalDir = typeof layersRaw["globalDir"] === "string" ? layersRaw["globalDir"] : LAYERS_DEFAULTS.globalDir;

  const dualMode = layersMode === "auto" && layersGlobalDir !== null;
  const globalDir = layersGlobalDir ?? join(homedir(), ".cache", "claude-memory");

  mkdirSync(dataDir, { recursive: true });

  if (dualMode) {
    mkdirSync(globalDir, { recursive: true });
  }

  // Map v3 embeddings.model to the runtime model string
  const embeddingModel = provider === "builtin"
    ? "Xenova/all-MiniLM-L6-v2"
    : (embObj["model"] as string);

  return {
    modelCacheDir: join(dataDir, "models"),
    embeddingProvider: provider as "builtin" | "ollama",
    embeddingModel,
    embeddingDim: embObj["dimension"] as number,
    ollamaUrl: "http://localhost:11434",
    ollamaModel: provider === "ollama" ? (embObj["model"] as string) : "nomic-embed-text",
    neo4jUri: neo4jObj["uri"] as string,
    neo4jUser: neo4jObj["user"] as string,
    neo4jPassword: neo4jObj["password"] as string,
    triggersStore: undefined,
    triggersSearch: undefined,
    triggersGraph: undefined,
    triggersList: undefined,
    triggersDelete: undefined,
    dualMode,
    globalDir,
    projectSlug: basename(process.cwd()),
    qdrantUrl: qdrantObj["url"] as string,
    qdrantApiKey: undefined,
    qdrantCollection: qdrantObj["collection"] as string,
    validation,
  };
}

/**
 * Build Config from environment variables (v2 backward compat).
 * Exported for testing.
 */
export function getConfigFromEnv(): Config {
  const dataDir =
    process.env["CLAUDE_MEMORY_DIR"] ?? join(homedir(), ".cache", "claude-memory");

  mkdirSync(dataDir, { recursive: true });

  const provider = (process.env["EMBEDDING_PROVIDER"] ?? "builtin") as Config["embeddingProvider"];
  if (provider !== "builtin" && provider !== "ollama") {
    throw new Error(`Unknown EMBEDDING_PROVIDER: "${provider}". Supported: builtin, ollama`);
  }

  const dimEnv = process.env["EMBEDDING_DIM"];
  const embeddingDim = dimEnv ? parseInt(dimEnv, 10) : DEFAULT_DIM[provider];

  const dualMode = !!process.env["CLAUDE_MEMORY_GLOBAL_DIR"];
  const globalDir = process.env["CLAUDE_MEMORY_GLOBAL_DIR"] ?? join(homedir(), ".cache", "claude-memory");

  if (dualMode) {
    mkdirSync(globalDir, { recursive: true });
  }

  const projectSlug = process.env["CLAUDE_MEMORY_PROJECT_SLUG"]
    ?? basename(process.cwd());

  return {
    modelCacheDir: process.env["CLAUDE_MEMORY_MODEL_CACHE"] ?? join(dataDir, "models"),
    embeddingProvider: provider,
    embeddingModel: "Xenova/all-MiniLM-L6-v2",
    embeddingDim,
    ollamaUrl: process.env["OLLAMA_URL"] ?? "http://localhost:11434",
    ollamaModel: process.env["OLLAMA_MODEL"] ?? "nomic-embed-text",
    neo4jUri: process.env["NEO4J_URI"] ?? "bolt://localhost:7687",
    neo4jUser: process.env["NEO4J_USER"] ?? "neo4j",
    neo4jPassword: process.env["NEO4J_PASSWORD"] ?? "memory_pass_2024",
    triggersStore: process.env["MEMORY_TRIGGERS_STORE"],
    triggersSearch: process.env["MEMORY_TRIGGERS_SEARCH"],
    triggersGraph: process.env["MEMORY_TRIGGERS_GRAPH"],
    triggersList: process.env["MEMORY_TRIGGERS_LIST"],
    triggersDelete: process.env["MEMORY_TRIGGERS_DELETE"],
    triggersValidate: process.env["MEMORY_TRIGGERS_VALIDATE"],
    dualMode,
    globalDir,
    projectSlug,
    qdrantUrl: process.env["QDRANT_URL"] || undefined,
    qdrantApiKey: process.env["QDRANT_API_KEY"] || undefined,
    qdrantCollection: process.env["QDRANT_COLLECTION"] || "semantic_memory_facts",
    validation: {
      mode: (process.env["VALIDATION_MODE"] as "on-store" | "off") || "off",
      claudePath: process.env["CLAUDE_PATH"] || "claude",
      model: process.env["VALIDATION_MODEL"] || "sonnet",
      conflictThreshold: parseFloat(process.env["VALIDATION_CONFLICT_THRESHOLD"] || "0.85"),
      sweepCooldownMin: parseInt(process.env["VALIDATION_SWEEP_COOLDOWN_MIN"] || "30", 10),
      sweepBatchSize: parseInt(process.env["VALIDATION_SWEEP_BATCH_SIZE"] || "20", 10),
      maxFactAgeDays: parseInt(process.env["VALIDATION_MAX_FACT_AGE_DAYS"] || "90", 10),
      maxValidationsPerMinute: parseInt(process.env["VALIDATION_MAX_PER_MINUTE"] || "10", 10),
    },
  };
}

/** Validate that a required field exists and has the expected type */
function validateRequired(
  obj: Record<string, unknown>,
  field: string,
  expectedType: string,
  filePath: string,
  prefix = "",
): void {
  if (!(field in obj) || obj[field] === undefined || obj[field] === null) {
    throw new Error(
      `Missing required field "${prefix}${field}" in "${filePath}".`
    );
  }
  if (typeof obj[field] !== expectedType) {
    throw new Error(
      `Field "${prefix}${field}" in "${filePath}" must be a ${expectedType}, got ${typeof obj[field]}.`
    );
  }
}
