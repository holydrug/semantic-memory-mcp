import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { basename, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir, platform, arch } from "node:os";
import { execSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { DEFAULT_TRIGGERS, type ToolKey } from "./triggers.js";
import { migrateEmbeddingDim } from "./db.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_VERSION = (JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf-8")) as { version: string }).version;

interface InitResult {
  envVars: Record<string, string>;
}

function isMacAppleSilicon(): boolean {
  return platform() === "darwin" && arch() === "arm64";
}

function isMac(): boolean {
  return platform() === "darwin";
}

interface ModelInfo {
  dim: number;
  size: string;
  desc: string;
}

const OLLAMA_MODELS: Record<string, ModelInfo> = {
  "nomic-embed-text": {
    dim: 768,
    size: "274 MB",
    desc: "Best balance of quality and speed. Great for code & docs (recommended)",
  },
  "mxbai-embed-large": {
    dim: 1024,
    size: "670 MB",
    desc: "Highest quality, slower. Best for complex semantic relationships",
  },
  "all-minilm": {
    dim: 384,
    size: "45 MB",
    desc: "Smallest and fastest. Good enough for simple keyword-like lookups",
  },
};

// ─── Helpers ────────────────────────────────────────────────

async function ask(rl: ReturnType<typeof createInterface>, question: string): Promise<string> {
  const answer = await rl.question(question);
  return answer.trim();
}

async function choose(
  rl: ReturnType<typeof createInterface>,
  prompt: string,
  options: string[],
  descriptions: string[],
): Promise<number> {
  console.log(`\n${prompt}`);
  for (let i = 0; i < options.length; i++) {
    const marker = i === 0 ? ">" : " ";
    console.log(`  ${marker} ${i + 1}) ${options[i]} — ${descriptions[i]}`);
  }
  const raw = await ask(rl, `Choose [1-${options.length}] (default: 1): `);
  const n = raw === "" ? 1 : parseInt(raw, 10);
  if (n < 1 || n > options.length || isNaN(n)) return 0;
  return n - 1;
}

function isOllamaRunning(url: string): boolean {
  try {
    execSync(`curl -sf ${url}/api/tags`, { timeout: 3000, stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function isDockerAvailable(): boolean {
  try {
    execSync("docker info", { timeout: 5000, stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function isDockerComposeAvailable(): boolean {
  try {
    execSync("docker compose version", { timeout: 5000, stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function startOllamaDocker(port: number): boolean {
  try {
    const existing = execSync("docker ps -a --filter name=ollama --format '{{.Names}}'", {
      timeout: 5000,
      stdio: "pipe",
    }).toString().trim();

    if (existing === "ollama") {
      console.log("  Starting existing 'ollama' container...");
      execSync("docker start ollama", { timeout: 10000, stdio: "pipe" });
    } else {
      console.log("  Creating and starting 'ollama' container...");
      execSync(
        `docker run -d --name ollama -p ${port}:11434 -v ollama_data:/root/.ollama ollama/ollama`,
        { timeout: 30000, stdio: "inherit" },
      );
    }
    return true;
  } catch {
    return false;
  }
}

function waitForOllama(url: string, maxWaitSec: number): boolean {
  const deadline = Date.now() + maxWaitSec * 1000;
  while (Date.now() < deadline) {
    if (isOllamaRunning(url)) return true;
    execSync("sleep 1");
  }
  return false;
}

function pullModel(url: string, model: string): boolean {
  try {
    console.log(`  Pulling model '${model}'... (this may take a minute)`);
    execSync(
      `curl -sf ${url}/api/pull -d '${JSON.stringify({ name: model })}'`,
      { timeout: 300000, stdio: "inherit" },
    );
    return true;
  } catch {
    return false;
  }
}

function isModelAvailable(url: string, model: string): boolean {
  try {
    const raw = execSync(`curl -sf ${url}/api/tags`, { timeout: 5000, stdio: "pipe" }).toString();
    const data = JSON.parse(raw) as { models?: Array<{ name: string }> };
    return data.models?.some((m) => m.name.startsWith(model)) ?? false;
  } catch {
    return false;
  }
}

function isBrewAvailable(): boolean {
  try {
    execSync("brew --version", { timeout: 5000, stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function isOllamaInstalled(): boolean {
  try {
    execSync("which ollama", { timeout: 3000, stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function installOllamaViaBrew(): boolean {
  try {
    console.log("  Installing Ollama via Homebrew...");
    execSync("brew install ollama", { timeout: 300000, stdio: "inherit" });
    return true;
  } catch {
    return false;
  }
}

function startOllamaNative(): boolean {
  try {
    execSync("ollama serve &", { timeout: 3000, stdio: "pipe", shell: "/bin/bash" });
    return true;
  } catch {
    return false;
  }
}

async function pullModelIfNeeded(
  rl: ReturnType<typeof createInterface>,
  ollamaUrl: string,
  model: string,
): Promise<void> {
  if (!isModelAvailable(ollamaUrl, model)) {
    const pullAnswer = await ask(rl, `\n  Model '${model}' not found. Pull it now? [Y/n]: `);
    if (pullAnswer === "" || pullAnswer.toLowerCase() === "y") {
      if (!pullModel(ollamaUrl, model)) {
        console.error(`  Failed to pull '${model}'. Pull manually: ollama pull ${model}`);
      }
    }
  } else {
    console.log(`  Model '${model}' is available.`);
  }
}

// ─── Docker Compose generation ──────────────────────────────

interface FullModeConfig {
  neo4jPassword: string;
  ollamaModel: string;
  embeddingDim: number;
  hasGpu: boolean;
  ollamaInDocker: boolean;
}

function generateDockerCompose(cfg: FullModeConfig): string {
  let ollamaBlock = "";

  if (cfg.ollamaInDocker) {
    const gpuSection = cfg.hasGpu
      ? `
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: 1
              capabilities: [gpu]`
      : "";

    ollamaBlock = `
  ollama:
    image: ollama/ollama
    container_name: claude-memory-ollama
    ports:
      - "11434:11434"${gpuSection}
    volumes:
      - ./data/ollama:/root/.ollama
`;
  }

  return `services:
  neo4j:
    image: neo4j:5-community
    container_name: claude-memory-neo4j
    ports:
      - "7474:7474"
      - "7687:7687"
    environment:
      NEO4J_AUTH: neo4j/${cfg.neo4jPassword}
      NEO4J_PLUGINS: '[]'
      NEO4J_server_memory_heap_initial__size: 512m
      NEO4J_server_memory_heap_max__size: 1G
    volumes:
      - ./data/neo4j:/data
    healthcheck:
      test: ["CMD", "cypher-shell", "-u", "neo4j", "-p", "${cfg.neo4jPassword}", "RETURN 1"]
      interval: 10s
      timeout: 5s
      retries: 5

${ollamaBlock}`;
}

function generateEnvFile(cfg: FullModeConfig): string {
  return `STORAGE_PROVIDER=neo4j
NEO4J_URI=bolt://localhost:7687
NEO4J_USER=neo4j
NEO4J_PASSWORD=${cfg.neo4jPassword}
EMBEDDING_PROVIDER=ollama
OLLAMA_URL=http://localhost:11434
OLLAMA_MODEL=${cfg.ollamaModel}
EMBEDDING_DIM=${cfg.embeddingDim}
`;
}

function waitForNeo4j(maxWaitSec: number): boolean {
  console.log("  Waiting for Neo4j to be ready...");
  const deadline = Date.now() + maxWaitSec * 1000;
  while (Date.now() < deadline) {
    try {
      execSync(
        "docker inspect --format='{{.State.Health.Status}}' claude-memory-neo4j",
        { timeout: 5000, stdio: "pipe" },
      ).toString().trim();
      const status = execSync(
        "docker inspect --format='{{.State.Health.Status}}' claude-memory-neo4j",
        { timeout: 5000, stdio: "pipe" },
      ).toString().trim();
      if (status === "healthy") return true;
    } catch {
      // container not ready yet
    }
    execSync("sleep 2");
  }
  return false;
}

// ─── Trigger words ──────────────────────────────────────────

const TRIGGER_ENV_KEYS: Record<ToolKey, string> = {
  store: "MEMORY_TRIGGERS_STORE",
  search: "MEMORY_TRIGGERS_SEARCH",
  graph: "MEMORY_TRIGGERS_GRAPH",
  list: "MEMORY_TRIGGERS_LIST",
};

const TRIGGER_LABELS: Record<ToolKey, string> = {
  store: "memory_store",
  search: "memory_search",
  graph: "memory_graph",
  list: "memory_list_entities",
};

async function configureTriggerWords(
  rl: ReturnType<typeof createInterface>,
  envVars: Record<string, string>,
): Promise<void> {
  const customize = await ask(rl, "\nCustomize trigger words? [y/N]: ");
  if (customize.toLowerCase() !== "y") return;

  console.log("\n  Add extra trigger words for each tool (comma-separated).");
  console.log("  These are ADDED to the defaults, not replacing them.");
  console.log("  Press Enter to skip a tool.\n");

  for (const key of ["store", "search", "graph", "list"] as ToolKey[]) {
    const defaults = DEFAULT_TRIGGERS[key];
    console.log(`  ${TRIGGER_LABELS[key]} defaults: ${defaults}`);
    const extra = await ask(rl, `  Extra triggers: `);
    if (extra) {
      envVars[TRIGGER_ENV_KEYS[key]] = extra;
    }
  }
}

// ─── Init flows ─────────────────────────────────────────────

async function runLightweightInit(
  rl: ReturnType<typeof createInterface>,
): Promise<InitResult> {
  const envVars: Record<string, string> = {};

  // Embedding provider selection
  const providerIdx = await choose(
    rl,
    "Embedding provider:",
    ["builtin", "ollama"],
    [
      "all-MiniLM-L6-v2, 384-dim, CPU, no dependencies",
      "higher-quality models via local Ollama (needs Docker or Ollama)",
    ],
  );

  const provider = providerIdx === 0 ? "builtin" : "ollama";

  if (provider === "ollama") {
    await configureOllamaEmbeddings(rl, envVars);
  }

  await configureTriggerWords(rl, envVars);

  return { envVars };
}

async function runFullInit(
  rl: ReturnType<typeof createInterface>,
): Promise<InitResult> {
  // Check Docker + Docker Compose
  if (!isDockerAvailable()) {
    console.error("\n  Docker is not available. Install Docker first: https://docs.docker.com/get-docker/");
    process.exit(1);
  }

  if (!isDockerComposeAvailable()) {
    console.error("\n  Docker Compose is not available. Install it: https://docs.docker.com/compose/install/");
    process.exit(1);
  }

  // Neo4j password
  const neo4jPassword = (await ask(rl, "\nNeo4j password (default: memory_pass_2024): "))
    || "memory_pass_2024";

  // Embedding model
  const modelNames = Object.keys(OLLAMA_MODELS);
  const modelDescs = modelNames.map(
    (m) => {
      const info = OLLAMA_MODELS[m]!;
      return `${info.dim}-dim, ${info.size} — ${info.desc}`;
    },
  );
  const modelIdx = await choose(rl, "Embedding model:", modelNames, modelDescs);
  const ollamaModel: string = modelNames[modelIdx] ?? modelNames[0]!;
  const embeddingDim: number = OLLAMA_MODELS[ollamaModel]?.dim ?? 768;

  // Ollama deployment strategy
  let ollamaInDocker = true;
  let hasGpu = false;

  if (isMac()) {
    console.log("\n  macOS detected. Ollama runs best natively (uses Metal GPU acceleration).");
    console.log("  Docker Compose will only include Neo4j.");
    ollamaInDocker = false;

    if (!isOllamaInstalled()) {
      if (isBrewAvailable()) {
        const installAnswer = await ask(rl, "\n  Ollama is not installed. Install via Homebrew? [Y/n]: ");
        if (installAnswer === "" || installAnswer.toLowerCase() === "y") {
          if (!installOllamaViaBrew()) {
            console.error("  Failed to install Ollama. Install manually: brew install ollama");
          }
        }
      } else {
        console.log("  Ollama is not installed. Install it: https://ollama.com/download/mac");
      }
    }

    if (isOllamaInstalled() && !isOllamaRunning("http://localhost:11434")) {
      const serveAnswer = await ask(rl, "\n  Ollama is installed but not running. Start it? [Y/n]: ");
      if (serveAnswer === "" || serveAnswer.toLowerCase() === "y") {
        startOllamaNative();
        console.log("  Starting Ollama...");
        if (waitForOllama("http://localhost:11434", 10)) {
          console.log("  Ollama is ready.");
        } else {
          console.log("  Ollama did not start in time. Run manually: ollama serve");
        }
      }
    }
  } else {
    const gpuAnswer = await ask(rl, "\nNVIDIA GPU available? [y/N]: ");
    hasGpu = gpuAnswer.toLowerCase() === "y";
  }

  const fullCfg: FullModeConfig = { neo4jPassword, ollamaModel, embeddingDim, hasGpu, ollamaInDocker };

  // Generate files in .semantic-memory/
  const projectDir = join(process.cwd(), ".semantic-memory");
  mkdirSync(join(projectDir, "data"), { recursive: true });

  const composePath = join(projectDir, "docker-compose.yml");
  const envPath = join(projectDir, ".env");

  writeFileSync(composePath, generateDockerCompose(fullCfg));
  writeFileSync(envPath, generateEnvFile(fullCfg));

  console.log(`\n  Generated:`);
  console.log(`    ${composePath}`);
  console.log(`    ${envPath}`);

  // Start containers
  const startAnswer = await ask(rl, "\n  Start containers now? [Y/n]: ");
  if (startAnswer === "" || startAnswer.toLowerCase() === "y") {
    console.log("\n  Starting containers...");
    try {
      execSync(`docker compose -f ${composePath} up -d`, {
        timeout: 120000,
        stdio: "inherit",
      });
    } catch {
      console.error("  Failed to start containers. Run manually:");
      console.error(`    cd ${projectDir} && docker compose up -d`);
      process.exit(1);
    }

    // Wait for Neo4j
    if (!waitForNeo4j(60)) {
      console.error("  Neo4j did not become healthy in time. Check: docker logs claude-memory-neo4j");
    } else {
      console.log("  Neo4j is ready.");
    }

    // Wait for Ollama (in Docker or native)
    const ollamaUrl = "http://localhost:11434";
    if (ollamaInDocker) {
      if (!waitForOllama(ollamaUrl, 15)) {
        console.error("  Ollama did not start in time. Check: docker logs claude-memory-ollama");
      } else {
        console.log("  Ollama is ready.");
        await pullModelIfNeeded(rl, ollamaUrl, ollamaModel);
      }
    } else {
      // Native Ollama (macOS)
      if (isOllamaRunning(ollamaUrl)) {
        console.log("  Ollama is running natively.");
        await pullModelIfNeeded(rl, ollamaUrl, ollamaModel);
      } else {
        console.log("\n  Ollama is not running. Start it with: ollama serve");
        console.log(`  Then pull the model: ollama pull ${ollamaModel}`);
      }
    }

    // Verify model is actually available before writing config
    if (isOllamaRunning(ollamaUrl) && !isModelAvailable(ollamaUrl, ollamaModel)) {
      console.warn(`\n  Warning: Model '${ollamaModel}' is not available in Ollama.`);
      console.warn(`  MCP server will fail to start until the model is pulled.`);
      console.warn(`  Run: curl ${ollamaUrl}/api/pull -d '{"name":"${ollamaModel}"}'`);
    }
  } else {
    console.log(`\n  Start later with:`);
    console.log(`    cd ${projectDir} && docker compose up -d`);
    if (!ollamaInDocker) {
      console.log(`    ollama serve  (in a separate terminal)`);
      console.log(`    ollama pull ${ollamaModel}`);
    }
  }

  // Trigger words
  const triggerEnvVars: Record<string, string> = {};
  await configureTriggerWords(rl, triggerEnvVars);

  const envVars: Record<string, string> = {
    STORAGE_PROVIDER: "neo4j",
    NEO4J_URI: "bolt://localhost:7687",
    NEO4J_USER: "neo4j",
    NEO4J_PASSWORD: neo4jPassword,
    EMBEDDING_PROVIDER: "ollama",
    OLLAMA_URL: "http://localhost:11434",
    OLLAMA_MODEL: ollamaModel,
    EMBEDDING_DIM: String(embeddingDim),
    ...triggerEnvVars,
  };

  return { envVars };
}

async function configureOllamaEmbeddings(
  rl: ReturnType<typeof createInterface>,
  envVars: Record<string, string>,
): Promise<void> {
  const ollamaUrl = (await ask(rl, "\nOllama URL (default: http://localhost:11434): "))
    || "http://localhost:11434";

  if (!isOllamaRunning(ollamaUrl)) {
    console.log(`\n  Ollama is not running at ${ollamaUrl}.`);

    if (isDockerAvailable()) {
      const startIt = await ask(rl, "  Start Ollama via Docker? [Y/n]: ");
      if (startIt === "" || startIt.toLowerCase() === "y") {
        const port = new URL(ollamaUrl).port || "11434";
        if (!startOllamaDocker(parseInt(port, 10))) {
          console.error("\n  Failed to start Ollama container. Please start it manually.");
          return;
        }
        console.log("  Waiting for Ollama to be ready...");
        if (!waitForOllama(ollamaUrl, 15)) {
          console.error("\n  Ollama did not start in time. Check: docker logs ollama");
          return;
        }
        console.log("  Ollama is ready.");
      } else {
        console.log("  Skipping. Make sure Ollama is running before using the MCP server.");
      }
    } else {
      console.log("  Docker is not available either.");
      console.log("  Install Ollama (https://ollama.com) or Docker, then re-run init.");
    }
  } else {
    console.log(`\n  Ollama is running at ${ollamaUrl}.`);
  }

  // Choose model
  const modelNames = Object.keys(OLLAMA_MODELS);
  const modelDescs = modelNames.map(
    (m) => {
      const info = OLLAMA_MODELS[m]!;
      return `${info.dim}-dim, ${info.size} — ${info.desc}`;
    },
  );
  const modelIdx = await choose(rl, "Embedding model:", modelNames, modelDescs);
  const model: string = modelNames[modelIdx] ?? modelNames[0]!;
  const dim: number = OLLAMA_MODELS[model]?.dim ?? 768;

  // Pull model if needed
  if (isOllamaRunning(ollamaUrl) && !isModelAvailable(ollamaUrl, model)) {
    const pullAnswer = await ask(rl, `\n  Model '${model}' not found. Pull it now? [Y/n]: `);
    if (pullAnswer === "" || pullAnswer.toLowerCase() === "y") {
      if (!pullModel(ollamaUrl, model)) {
        console.error(`  Failed to pull '${model}'. Pull it manually: ollama pull ${model}`);
      }
    }
  } else if (isOllamaRunning(ollamaUrl)) {
    console.log(`\n  Model '${model}' is available.`);
  }

  envVars["EMBEDDING_PROVIDER"] = "ollama";
  envVars["OLLAMA_URL"] = ollamaUrl;
  envVars["OLLAMA_MODEL"] = model;
  envVars["EMBEDDING_DIM"] = String(dim);
}

// ─── Main ───────────────────────────────────────────────────

export async function runInit(): Promise<void> {
  const claudeJsonPath = join(homedir(), ".claude.json");
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  try {
    let config: Record<string, unknown>;

    if (existsSync(claudeJsonPath)) {
      config = JSON.parse(readFileSync(claudeJsonPath, "utf-8"));
    } else {
      console.error("~/.claude.json not found — creating it. Is Claude Code installed?");
      config = {};
    }

    // Step 1: Choose setup mode
    const modeIdx = await choose(
      rl,
      "Setup mode:",
      ["Lightweight", "Full"],
      [
        "SQLite + built-in embeddings — zero dependencies",
        "Neo4j + Ollama via Docker Compose — higher quality, your hardware",
      ],
    );

    let result: InitResult;
    if (modeIdx === 0) {
      result = await runLightweightInit(rl);
    } else {
      result = await runFullInit(rl);
    }

    // Migrate existing databases if embedding dimension changed
    const newDim = result.envVars["EMBEDDING_DIM"]
      ? parseInt(result.envVars["EMBEDDING_DIM"], 10)
      : 384; // builtin default

    const dbsToMigrate = [
      { label: "Global", path: join(homedir(), ".cache", "claude-memory", "memory.db") },
      { label: "Project", path: join(process.cwd(), ".semantic-memory", "memory.db") },
    ];

    for (const { label, path } of dbsToMigrate) {
      try {
        const m = migrateEmbeddingDim(path, newDim);
        if (m.status === "migrated") {
          if (m.droppedFacts! > 0 || m.droppedEntities! > 0) {
            console.log(
              `  ${label} DB: dim ${m.oldDim} → ${newDim}, cleared ${m.droppedEntities} entities and ${m.droppedFacts} facts`
            );
          } else {
            console.log(`  ${label} DB: migrated dim ${m.oldDim} → ${newDim}`);
          }
        }
      } catch {
        // DB not accessible — will be created fresh at server start
      }
    }

    // Step: Per-project memory
    const perProject = await ask(rl, "\nEnable per-project memory for this folder? [y/N]: ");
    const enablePerProject = perProject.toLowerCase() === "y";

    // Build server entry with pinned version to avoid npx cache issues
    const npxPkg = `semantic-memory-mcp@${PKG_VERSION}`;
    const serverEntry: Record<string, unknown> = {
      type: "stdio",
      command: "npx",
      args: ["-y", npxPkg],
    };

    // Always update global mcpServers entry (including re-runs with new settings)
    const mcpServers = (config["mcpServers"] ?? {}) as Record<string, unknown>;
    const globalEntry: Record<string, unknown> = { ...serverEntry };
    if (Object.keys(result.envVars).length > 0) {
      globalEntry["env"] = { ...result.envVars };
    }
    mcpServers["semantic-memory"] = globalEntry;
    config["mcpServers"] = mcpServers;

    if (enablePerProject) {
      const cwd = process.cwd();
      const slug = basename(cwd);
      const globalMemDir = join(homedir(), ".cache", "claude-memory");

      // Build per-project env with dual mode vars
      const projectEnv: Record<string, string> = {
        ...result.envVars,
        CLAUDE_MEMORY_DIR: "./.semantic-memory",
        CLAUDE_MEMORY_GLOBAL_DIR: globalMemDir,
        CLAUDE_MEMORY_PROJECT_SLUG: slug,
        ...(result.envVars["STORAGE_PROVIDER"] === "neo4j"
          ? { GLOBAL_STORAGE_PROVIDER: "neo4j" }
          : {}),
      };

      const projectServerEntry: Record<string, unknown> = {
        type: "stdio",
        command: "npx",
        args: ["-y", npxPkg],
        env: projectEnv,
      };

      // Create projects section
      const projects = (config["projects"] ?? {}) as Record<string, unknown>;
      const projectConfig = (projects[cwd] ?? {}) as Record<string, unknown>;
      const projectMcpServers = (projectConfig["mcpServers"] ?? {}) as Record<string, unknown>;
      projectMcpServers["semantic-memory"] = projectServerEntry;
      projectConfig["mcpServers"] = projectMcpServers;
      projects[cwd] = projectConfig;
      config["projects"] = projects;

      console.log(`\n  Project memory: ./.semantic-memory/`);
      console.log(`  Global memory: ${globalMemDir}/`);
      console.log("  Run 'npx semantic-memory-mcp promote' to review and promote facts to global memory.");
    }
    // Global entry is already updated above for both single and dual modes

    // Save config
    writeFileSync(claudeJsonPath, JSON.stringify(config, null, 2) + "\n");

    console.log(`\n  Written to ~/.claude.json`);
    console.log("  Restart Claude Code to activate.");
  } finally {
    rl.close();
  }
}
