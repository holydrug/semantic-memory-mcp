import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

function resolveComposeFile(): string {
  // 1. SEMANTIC_MEMORY_CONFIG → derive dataDir
  const configPath = process.env["SEMANTIC_MEMORY_CONFIG"];
  if (configPath && existsSync(configPath)) {
    const dataDir = join(configPath, "..");
    const composePath = join(dataDir, "docker-compose.yml");
    if (existsSync(composePath)) return composePath;
  }

  // 2. Default location
  const defaultCompose = join(homedir(), ".semantic-memory", "docker-compose.yml");
  if (existsSync(defaultCompose)) return defaultCompose;

  throw new Error(
    "docker-compose.yml not found. Run 'semantic-memory-mcp init' first.",
  );
}

export async function runStart(): Promise<void> {
  const composePath = resolveComposeFile();
  console.error(`[semantic-memory] Starting containers from ${composePath}...`);
  try {
    execSync(`docker compose -f "${composePath}" up -d --wait`, {
      stdio: ["ignore", "inherit", "inherit"],
    });
    console.error("[semantic-memory] Containers started.");
  } catch {
    console.error("[semantic-memory] Failed to start containers.");
    process.exit(1);
  }
}
