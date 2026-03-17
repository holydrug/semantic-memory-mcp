import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { createInterface } from "node:readline/promises";
import { randomUUID } from "node:crypto";
import { detectState } from "./init-detect.js";
import {
  checkDocker,
  checkDockerCompose,
  checkPorts,
  generateCompose,
  composeUp,
  composeDown,
  waitForHealthy,
  detectWSL,
} from "../docker.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_VERSION = (
  JSON.parse(readFileSync(join(__dirname, "..", "..", "package.json"), "utf-8")) as { version: string }
).version;

// ─── V3 Config Interface (matches config.json schema) ────────────────

interface V3Config {
  version: 3;
  dataDir: string;
  neo4j: {
    uri: string;
    user: string;
    password: string;
  };
  qdrant: {
    url: string;
    collection: string;
  };
  embeddings: {
    provider: "builtin" | "ollama";
    model: string;
    dimension: number;
  };
  validation: {
    mode: string;
    claudePath: string;
    model: string;
    conflictThreshold: number;
    sweepCooldownMin: number;
    sweepBatchSize: number;
    maxFactAgeDays: number;
    maxValidationsPerMinute: number;
  };
  ingest: {
    batchSize: number;
    model: string;
  };
  layers: {
    mode: string;
    globalDir: string | null;
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────

async function ask(rl: ReturnType<typeof createInterface>, question: string): Promise<string> {
  const answer = await rl.question(question);
  return answer.trim();
}

async function askYesNo(
  rl: ReturnType<typeof createInterface>,
  question: string,
  defaultYes: boolean,
): Promise<boolean> {
  const hint = defaultYes ? "[Y/n]" : "[y/N]";
  for (;;) {
    const raw = (await rl.question(`${question} ${hint}: `)).trim().toLowerCase();
    if (raw === "") return defaultYes;
    if (raw === "y" || raw === "yes") return true;
    if (raw === "n" || raw === "no") return false;
    console.error("  Please answer y or n.");
  }
}

async function choose(
  rl: ReturnType<typeof createInterface>,
  prompt: string,
  options: string[],
  descriptions: string[],
): Promise<number> {
  console.error(`\n${prompt}`);
  for (let i = 0; i < options.length; i++) {
    const marker = i === 0 ? ">" : " ";
    console.error(`  ${marker} ${i + 1}) ${options[i]} — ${descriptions[i]}`);
  }
  const raw = await ask(rl, `Choose [1-${options.length}] (default: 1): `);
  const n = raw === "" ? 1 : parseInt(raw, 10);
  if (n < 1 || n > options.length || isNaN(n)) return 0;
  return n - 1;
}

function createDefaultConfig(dataDir: string, password: string): V3Config {
  return {
    version: 3,
    dataDir,
    neo4j: {
      uri: "bolt://localhost:7687",
      user: "neo4j",
      password,
    },
    qdrant: {
      url: "http://localhost:6333",
      collection: "semantic_memory",
    },
    embeddings: {
      provider: "builtin",
      model: "all-MiniLM-L6-v2",
      dimension: 384,
    },
    validation: {
      mode: "on-store",
      claudePath: "claude",
      model: "sonnet",
      conflictThreshold: 0.85,
      sweepCooldownMin: 30,
      sweepBatchSize: 20,
      maxFactAgeDays: 90,
      maxValidationsPerMinute: 10,
    },
    ingest: {
      batchSize: 5,
      model: "sonnet",
    },
    layers: {
      mode: "auto",
      globalDir: null,
    },
  };
}

function readV3Config(dataDir: string): V3Config {
  const configPath = join(dataDir, "config.json");
  return JSON.parse(readFileSync(configPath, "utf-8")) as V3Config;
}

function writeV3Config(dataDir: string, config: V3Config): void {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, "config.json"), JSON.stringify(config, null, 2) + "\n");
}

/**
 * Update ~/.claude.json with semantic-memory MCP entry pointing to config.json.
 */
export function updateClaudeJson(configPath: string): void {
  const claudeJsonPath = join(homedir(), ".claude.json");

  let config: Record<string, unknown> = {};
  if (existsSync(claudeJsonPath)) {
    try {
      config = JSON.parse(readFileSync(claudeJsonPath, "utf-8")) as Record<string, unknown>;
    } catch {
      config = {};
    }
  }

  const mcpServers = (config["mcpServers"] ?? {}) as Record<string, unknown>;

  const npxPkg = `semantic-memory-mcp@${PKG_VERSION}`;

  mcpServers["semantic-memory"] = {
    type: "stdio",
    command: "npx",
    args: ["-y", npxPkg],
    env: {
      SEMANTIC_MEMORY_CONFIG: configPath,
    },
  };

  config["mcpServers"] = mcpServers;
  writeFileSync(claudeJsonPath, JSON.stringify(config, null, 2) + "\n");
}

// ─── Init Modes ──────────────────────────────────────────────────────

async function freshInstall(
  rl: ReturnType<typeof createInterface>,
  dataDir: string,
): Promise<void> {
  console.error("\n=== Fresh Install ===\n");

  // 1. Check Docker + Docker Compose
  if (!checkDocker()) {
    throw new Error(
      "Docker is not available. Install Docker first: https://docs.docker.com/get-docker/",
    );
  }
  if (!checkDockerCompose()) {
    throw new Error(
      "Docker Compose is not available. Install it: https://docs.docker.com/compose/install/",
    );
  }
  console.error("  Docker and Docker Compose: OK");

  // 2. Check port availability
  const requiredPorts = [7687, 6333, 7474];
  const portStatus = checkPorts(requiredPorts);
  const occupiedPorts: Array<{ port: number; process: string }> = [];

  for (const [port, proc] of portStatus) {
    if (proc !== null) {
      occupiedPorts.push({ port, process: proc });
    }
  }

  if (occupiedPorts.length > 0) {
    const details = occupiedPorts
      .map((p) => `    Port ${p.port} is used by: ${p.process}`)
      .join("\n");
    throw new Error(
      `Required ports are occupied:\n${details}\n\n  Free these ports or stop the processes, then retry.`,
    );
  }
  console.error("  Ports 7687, 6333, 7474: available");

  // 3. Auto-generate password
  const neo4jPassword = randomUUID();

  // 4. Choose embedding provider
  const providerIdx = await choose(
    rl,
    "Embedding provider:",
    ["builtin", "ollama"],
    [
      "all-MiniLM-L6-v2, 384-dim, CPU, no extra dependencies (recommended)",
      "Higher-quality models via local Ollama (requires Ollama running)",
    ],
  );

  const config = createDefaultConfig(dataDir, neo4jPassword);

  if (providerIdx === 1) {
    config.embeddings.provider = "ollama";
    config.embeddings.model = "nomic-embed-text";
    config.embeddings.dimension = 768;

    // WSL detection
    if (detectWSL()) {
      console.error(
        "\n  WSL detected. Using host.docker.internal for Ollama URL" +
          "\n  (Ollama on Windows host is not reachable via WSL's localhost).",
      );
      config.qdrant.url = "http://localhost:6333"; // Qdrant runs in docker, accessible on localhost
      // Ollama URL is not in config.json — it's runtime. But we note it for the user.
      console.error("  Ollama endpoint: http://host.docker.internal:11434");
    }
  }

  // 5. Write config.json
  mkdirSync(join(dataDir, "data", "neo4j"), { recursive: true });
  mkdirSync(join(dataDir, "data", "qdrant"), { recursive: true });
  writeV3Config(dataDir, config);
  console.error(`\n  Config written: ${join(dataDir, "config.json")}`);

  // 6. Generate docker-compose.yml
  const composeContent = generateCompose({
    neo4jPassword,
    neo4jBoltPort: 7687,
    neo4jHttpPort: 7474,
    qdrantPort: 6333,
    dataDir,
  });
  const composePath = join(dataDir, "docker-compose.yml");
  writeFileSync(composePath, composeContent);
  console.error(`  Compose written: ${composePath}`);

  // 7. docker compose up -d + healthcheck wait
  console.error("\n  Starting containers...");
  try {
    composeUp(composePath);
  } catch (err) {
    throw new Error(
      `Failed to start containers. Run manually:\n    cd ${dataDir} && docker compose up -d\n\n  Error: ${(err as Error).message}`,
    );
  }

  console.error("  Waiting for containers to become healthy...");
  const healthy = waitForHealthy(composePath, 90000);
  if (!healthy) {
    console.error(
      "  Warning: containers did not become healthy in 90 seconds.\n" +
        "  Check: docker compose -f " + composePath + " ps",
    );
  } else {
    console.error("  All containers healthy.");
  }

  // 8. Update ~/.claude.json
  const configPath = join(dataDir, "config.json");
  updateClaudeJson(configPath);
  console.error("  Updated ~/.claude.json");

  // 9. Print summary
  console.error(`
=== Setup Complete ===

  Data directory: ${dataDir}
  Neo4j password: ${neo4jPassword}
  Neo4j:          bolt://localhost:7687
  Qdrant:         http://localhost:6333
  Embeddings:     ${config.embeddings.provider} (${config.embeddings.model}, ${config.embeddings.dimension}-dim)

  Restart Claude Code to activate semantic-memory.
  Config: ${configPath}
`);
}

function noOp(dataDir: string, config: V3Config): void {
  console.error(`
semantic-memory is already configured and running.
  Data:       ${dataDir}
  Embeddings: ${config.embeddings.provider} (${config.embeddings.model}, ${config.embeddings.dimension}-dim)
  Neo4j:      ${config.neo4j.uri}
  Qdrant:     ${config.qdrant.url}

  Reconfigure: npx semantic-memory-mcp init --reconfigure
  Status:      npx semantic-memory-mcp status
  Reset:       npx semantic-memory-mcp init --reset
`);
}

async function repair(
  rl: ReturnType<typeof createInterface>,
  dataDir: string,
  config: V3Config,
  state: Awaited<ReturnType<typeof detectState>>,
): Promise<void> {
  console.error("\n=== Repair Mode ===\n");

  const issues: string[] = [];

  if (!state.has_compose) {
    issues.push("docker-compose.yml is missing");
  }
  if (!state.containers_ok) {
    issues.push("containers are not running or unhealthy");
  }
  if (!state.claude_json_ok) {
    issues.push("~/.claude.json is missing semantic-memory entry");
  }

  if (issues.length === 0) {
    console.error("  No issues found. Everything looks good.");
    return;
  }

  console.error("  Issues detected:");
  for (const issue of issues) {
    console.error(`    - ${issue}`);
  }

  const proceed = await askYesNo(rl, "\n  Fix automatically?", true);
  if (!proceed) {
    console.error("  Repair cancelled.");
    return;
  }

  // Regenerate docker-compose.yml from config.json
  if (!state.has_compose) {
    const neo4jPort = parseInt(config.neo4j.uri.split(":").pop() ?? "7687", 10);
    const qdrantPort = parseInt(config.qdrant.url.split(":").pop() ?? "6333", 10);

    const composeContent = generateCompose({
      neo4jPassword: config.neo4j.password,
      neo4jBoltPort: neo4jPort,
      neo4jHttpPort: 7474,
      qdrantPort,
      dataDir,
    });
    const composePath = join(dataDir, "docker-compose.yml");
    writeFileSync(composePath, composeContent);
    console.error("  Regenerated docker-compose.yml");
  }

  // Start containers if not running
  if (!state.containers_ok) {
    const composePath = join(dataDir, "docker-compose.yml");
    if (existsSync(composePath)) {
      console.error("  Starting containers...");
      try {
        composeUp(composePath);
        const healthy = waitForHealthy(composePath, 90000);
        if (healthy) {
          console.error("  Containers healthy.");
        } else {
          console.error("  Warning: containers did not become healthy in time.");
        }
      } catch (err) {
        console.error(`  Failed to start containers: ${(err as Error).message}`);
      }
    }
  }

  // Fix ~/.claude.json
  if (!state.claude_json_ok) {
    const configPath = join(dataDir, "config.json");
    updateClaudeJson(configPath);
    console.error("  Updated ~/.claude.json");
  }

  console.error("\n  Repair complete.");
}

async function reconfigure(
  rl: ReturnType<typeof createInterface>,
  dataDir: string,
  config: V3Config,
): Promise<void> {
  console.error("\n=== Reconfigure Mode ===\n");
  console.error("  Current settings (press Enter to keep):\n");

  // Embedding provider
  const currentProvider = config.embeddings.provider;
  const providerIdx = await choose(
    rl,
    `Embedding provider (current: ${currentProvider}):`,
    ["builtin", "ollama"],
    [
      "all-MiniLM-L6-v2, 384-dim, CPU, no extra dependencies",
      "Higher-quality models via local Ollama",
    ],
  );

  const newProvider = providerIdx === 0 ? "builtin" : "ollama";
  const embeddingChanged = newProvider !== currentProvider;

  if (embeddingChanged) {
    console.error(`
  DANGER: Changing embedding provider from '${currentProvider}' to '${newProvider}'.
  This invalidates ALL existing vectors.
  Qdrant collection will need to be recreated and all facts re-embedded.
`);
    const confirm = await askYesNo(rl, "  Proceed with embedding change?", false);
    if (!confirm) {
      console.error("  Reconfigure cancelled — embedding change rejected.");
      return;
    }
  }

  // Update config
  if (newProvider === "builtin") {
    config.embeddings.provider = "builtin";
    config.embeddings.model = "all-MiniLM-L6-v2";
    config.embeddings.dimension = 384;
  } else {
    config.embeddings.provider = "ollama";
    config.embeddings.model = "nomic-embed-text";
    config.embeddings.dimension = 768;
  }

  // Password is NEVER re-asked
  writeV3Config(dataDir, config);
  console.error(`\n  Config updated: ${join(dataDir, "config.json")}`);

  // Regenerate compose if needed
  const neo4jPort = parseInt(config.neo4j.uri.split(":").pop() ?? "7687", 10);
  const qdrantPort = parseInt(config.qdrant.url.split(":").pop() ?? "6333", 10);

  const composeContent = generateCompose({
    neo4jPassword: config.neo4j.password,
    neo4jBoltPort: neo4jPort,
    neo4jHttpPort: 7474,
    qdrantPort,
    dataDir,
  });
  const composePath = join(dataDir, "docker-compose.yml");
  writeFileSync(composePath, composeContent);
  console.error("  Regenerated docker-compose.yml");

  // Restart containers
  console.error("  Restarting containers...");
  try {
    composeDown(composePath);
  } catch {
    // ignore if already stopped
  }
  try {
    composeUp(composePath);
    waitForHealthy(composePath, 90000);
    console.error("  Containers restarted.");
  } catch (err) {
    console.error(`  Failed to restart containers: ${(err as Error).message}`);
  }

  // Update claude.json
  updateClaudeJson(join(dataDir, "config.json"));

  if (embeddingChanged) {
    console.error(
      "\n  Embedding changed. Run re-embed to update vectors:" +
        "\n    npx semantic-memory-mcp migrate-qdrant --re-embed",
    );
  }

  console.error("\n  Reconfigure complete. Restart Claude Code to apply changes.");
}

async function resetMode(
  rl: ReturnType<typeof createInterface>,
  dataDir: string,
): Promise<void> {
  console.error("\n=== Reset Mode ===\n");
  console.error(`  This will DELETE all data in: ${dataDir}`);
  console.error("  Including: config.json, docker-compose.yml, Neo4j data, Qdrant data.\n");

  const confirmation = await ask(rl, '  Type YES to confirm: ');
  if (confirmation !== "YES") {
    console.error("  Reset cancelled.");
    return;
  }

  // Stop containers if compose exists
  const composePath = join(dataDir, "docker-compose.yml");
  if (existsSync(composePath)) {
    console.error("  Stopping containers...");
    try {
      composeDown(composePath);
    } catch {
      // ignore
    }
  }

  // Remove data directory contents
  if (existsSync(dataDir)) {
    rmSync(dataDir, { recursive: true, force: true });
    console.error(`  Removed: ${dataDir}`);
  }

  // Proceed to fresh install
  console.error("\n  Starting fresh install...");
  await freshInstall(rl, dataDir);
}

function v2MigrationPlaceholder(dataDir: string): void {
  console.error(`
V2 installation detected at: ${dataDir}
  Found .env file (v2 configuration).
  Migration to v3 will be implemented in Step 10.

  For now, your v2 installation continues to work as-is.
`);
}

// ─── Main Entry Point ────────────────────────────────────────────────

export interface InitArgs {
  dataDir?: string;
  reconfigure?: boolean;
  reset?: boolean;
}

export function parseInitArgs(argv: string[]): InitArgs {
  const args: InitArgs = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--data-dir" && i + 1 < argv.length) {
      args.dataDir = argv[i + 1];
      i++;
    } else if (arg === "--reconfigure") {
      args.reconfigure = true;
    } else if (arg === "--reset") {
      args.reset = true;
    }
  }

  return args;
}

export async function runInitV3(args: InitArgs): Promise<void> {
  const state = await detectState({ dataDir: args.dataDir });
  const rl = createInterface({ input: process.stdin, output: process.stderr });

  try {
    // Routing logic

    // --reset flag => Reset mode
    if (args.reset) {
      await resetMode(rl, state.dataDir);
      return;
    }

    // has_v3 + healthy + claude_json_ok + !--reconfigure => No-op
    if (
      state.has_v3_config &&
      state.containers_ok &&
      state.claude_json_ok &&
      !args.reconfigure
    ) {
      const config = readV3Config(state.dataDir);
      noOp(state.dataDir, config);
      return;
    }

    // has_v3 + --reconfigure => Reconfigure wizard
    if (state.has_v3_config && args.reconfigure) {
      const config = readV3Config(state.dataDir);
      await reconfigure(rl, state.dataDir, config);
      return;
    }

    // has_v3 + broken => Repair
    if (state.has_v3_config) {
      const config = readV3Config(state.dataDir);
      await repair(rl, state.dataDir, config, state);
      return;
    }

    // has_v2_env => V2 Migration placeholder
    if (state.has_v2_env) {
      v2MigrationPlaceholder(state.dataDir);
      return;
    }

    // else => Fresh Install
    await freshInstall(rl, state.dataDir);
  } finally {
    rl.close();
  }
}
