import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

function resolveComposeFile(): string {
  const configPath = process.env["SEMANTIC_MEMORY_CONFIG"];
  if (configPath && existsSync(configPath)) {
    const dataDir = join(configPath, "..");
    const composePath = join(dataDir, "docker-compose.yml");
    if (existsSync(composePath)) return composePath;
  }

  const defaultCompose = join(homedir(), ".semantic-memory", "docker-compose.yml");
  if (existsSync(defaultCompose)) return defaultCompose;

  throw new Error(
    "docker-compose.yml not found. Run 'semantic-memory-mcp init' first.",
  );
}

export async function runStop(): Promise<void> {
  const composePath = resolveComposeFile();
  console.error(`[semantic-memory] Stopping containers from ${composePath}...`);
  try {
    execSync(`docker compose -f "${composePath}" down`, {
      stdio: ["ignore", "inherit", "inherit"],
    });
    console.error("[semantic-memory] Containers stopped.");
  } catch {
    console.error("[semantic-memory] Failed to stop containers.");
    process.exit(1);
  }
}
