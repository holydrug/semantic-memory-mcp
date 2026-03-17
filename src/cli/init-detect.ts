import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { execSync } from "node:child_process";

export interface InitState {
  dataDir: string;
  has_v3_config: boolean;
  has_v2_env: boolean;
  has_compose: boolean;
  containers_ok: boolean;
  claude_json_ok: boolean;
}

/**
 * Resolve dataDir in priority order:
 * 1. --data-dir argument (explicit)
 * 2. ~/.semantic-memory/config.json exists -> ~/
 * 3. ./.semantic-memory/.env exists -> cwd (v2)
 * 4. ~/.semantic-memory/.env exists -> ~/ (v2)
 * 5. nothing found -> default ~/.semantic-memory/
 */
export function resolveDataDir(explicitDataDir?: string): string {
  if (explicitDataDir) {
    return explicitDataDir;
  }

  const homeDir = join(homedir(), ".semantic-memory");

  // Check home config.json (v3)
  if (existsSync(join(homeDir, "config.json"))) {
    return homeDir;
  }

  // Check cwd .env (v2)
  const cwdDir = join(process.cwd(), ".semantic-memory");
  if (existsSync(join(cwdDir, ".env"))) {
    return cwdDir;
  }

  // Check home .env (v2)
  if (existsSync(join(homeDir, ".env"))) {
    return homeDir;
  }

  // Default
  return homeDir;
}

/**
 * Check if Docker containers for semantic-memory are healthy.
 * Uses docker compose ps to check status.
 */
function checkContainersHealthy(dataDir: string): boolean {
  const composeFile = join(dataDir, "docker-compose.yml");
  if (!existsSync(composeFile)) {
    return false;
  }

  try {
    const output = execSync(
      `docker compose -f "${composeFile}" ps --format json`,
      { timeout: 10000, stdio: "pipe" },
    ).toString().trim();

    if (!output) return false;

    // docker compose ps --format json outputs one JSON object per line
    const lines = output.split("\n").filter(Boolean);
    if (lines.length === 0) return false;

    for (const line of lines) {
      try {
        const container = JSON.parse(line) as { State?: string; Health?: string };
        // A container is "ok" if it's running. Healthy is even better.
        if (container.State !== "running") return false;
      } catch {
        return false;
      }
    }

    return true;
  } catch {
    return false;
  }
}

/**
 * Check if ~/.claude.json has semantic-memory MCP entry with SEMANTIC_MEMORY_CONFIG.
 */
function checkClaudeJson(): boolean {
  const claudeJsonPath = join(homedir(), ".claude.json");
  if (!existsSync(claudeJsonPath)) return false;

  try {
    const content = JSON.parse(readFileSync(claudeJsonPath, "utf-8")) as Record<string, unknown>;
    const mcpServers = content["mcpServers"] as Record<string, unknown> | undefined;
    if (!mcpServers) return false;

    const entry = mcpServers["semantic-memory"] as Record<string, unknown> | undefined;
    if (!entry) return false;

    // v3 entry should have SEMANTIC_MEMORY_CONFIG env var
    const env = entry["env"] as Record<string, string> | undefined;
    if (env?.["SEMANTIC_MEMORY_CONFIG"]) return true;

    // Also consider it ok if there's any entry at all (v2 compat)
    return true;
  } catch {
    return false;
  }
}

/**
 * Detect current state for init routing.
 */
export async function detectState(args: { dataDir?: string }): Promise<InitState> {
  const dataDir = resolveDataDir(args.dataDir);

  const has_v3_config = existsSync(join(dataDir, "config.json"));
  const has_v2_env = existsSync(join(dataDir, ".env")) && !has_v3_config;
  const has_compose = existsSync(join(dataDir, "docker-compose.yml"));
  const containers_ok = has_compose ? checkContainersHealthy(dataDir) : false;
  const claude_json_ok = checkClaudeJson();

  return {
    dataDir,
    has_v3_config,
    has_v2_env,
    has_compose,
    containers_ok,
    claude_json_ok,
  };
}
