import { homedir } from "node:os";
import { basename, join } from "node:path";
import { mkdirSync } from "node:fs";

export interface ValidationConfig {
  mode: "off" | "on-store" | "full";
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

export function getConfig(): Config {
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

  const validationMode = (process.env["VALIDATION_MODE"] ?? "on-store") as ValidationConfig["mode"];

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
      mode: validationMode,
      claudePath: process.env["CLAUDE_PATH"] ?? "claude",
      model: process.env["VALIDATION_MODEL"] ?? "sonnet",
      conflictThreshold: parseFloat(process.env["VALIDATION_CONFLICT_THRESHOLD"] ?? "0.85"),
      sweepCooldownMin: parseInt(process.env["VALIDATION_SWEEP_COOLDOWN_MIN"] ?? "30", 10),
      sweepBatchSize: parseInt(process.env["VALIDATION_SWEEP_BATCH_SIZE"] ?? "20", 10),
      maxFactAgeDays: parseInt(process.env["VALIDATION_MAX_FACT_AGE_DAYS"] ?? "90", 10),
      maxValidationsPerMinute: parseInt(process.env["VALIDATION_MAX_PER_MINUTE"] ?? "10", 10),
    },
  };
}
