import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { execSync } from "node:child_process";

interface StatusConfig {
  dataDir: string;
  embeddings?: {
    provider: string;
    model?: string;
    dimension?: number;
  };
  neo4j?: {
    uri: string;
  };
  qdrant?: {
    url: string;
  };
}

function tryLoadConfig(): StatusConfig | null {
  // 1. SEMANTIC_MEMORY_CONFIG env var
  const configPath = process.env["SEMANTIC_MEMORY_CONFIG"];
  if (configPath && existsSync(configPath)) {
    try {
      const raw = readFileSync(configPath, "utf-8");
      return JSON.parse(raw) as StatusConfig;
    } catch {
      // corrupt config
    }
  }

  // 2. Default location
  const defaultPath = join(homedir(), ".semantic-memory", "config.json");
  if (existsSync(defaultPath)) {
    try {
      const raw = readFileSync(defaultPath, "utf-8");
      return JSON.parse(raw) as StatusConfig;
    } catch {
      // corrupt config
    }
  }

  return null;
}

function checkContainerHealth(composePath: string): string {
  try {
    const output = execSync(
      `docker compose -f "${composePath}" ps --format json`,
      { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] },
    );
    if (!output.trim()) return "not running";
    return "running";
  } catch {
    return "not running";
  }
}

export async function runStatus(): Promise<void> {
  const config = tryLoadConfig();

  if (!config) {
    console.error("semantic-memory is not configured.");
    console.error('  Run "semantic-memory-mcp init" to set up.');
    return;
  }

  const dataDir = config.dataDir ?? join(homedir(), ".semantic-memory");
  const composePath = join(dataDir, "docker-compose.yml");

  const containerStatus = existsSync(composePath)
    ? checkContainerHealth(composePath)
    : "no docker-compose.yml";

  const provider = config.embeddings?.provider ?? "builtin";
  const model = config.embeddings?.model ?? "all-MiniLM-L6-v2";
  const dim = config.embeddings?.dimension ?? 384;
  const neo4jUri = config.neo4j?.uri ?? "bolt://localhost:7687";
  const qdrantUrl = config.qdrant?.url ?? "http://localhost:6333";

  console.error(`semantic-memory status`);
  console.error(`  Data:       ${dataDir}`);
  console.error(`  Embeddings: ${provider} (${model}, ${dim}-dim)`);
  console.error(`  Neo4j:      ${neo4jUri}`);
  console.error(`  Qdrant:     ${qdrantUrl}`);
  console.error(`  Containers: ${containerStatus}`);
}
