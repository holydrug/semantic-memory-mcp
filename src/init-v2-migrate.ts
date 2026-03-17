import { readFileSync, writeFileSync, existsSync, renameSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { execSync } from "node:child_process";
import { createInterface } from "node:readline/promises";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_VERSION = (
  JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf-8")) as {
    version: string;
  }
).version;

// ─── Exported pure functions (testable) ────────────────────

/**
 * Parse a .env file into a key-value record.
 * Handles KEY=VALUE, KEY="VALUE", KEY='VALUE', comments (#), empty lines.
 */
export function parseEnvFile(envPath: string): Record<string, string> {
  const content = readFileSync(envPath, "utf-8");
  return parseEnvContent(content);
}

/**
 * Parse .env content string (for testability without filesystem).
 */
export function parseEnvContent(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;

    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();

    // Strip surrounding quotes
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    result[key] = value;
  }
  return result;
}

/**
 * Extract Neo4j password from docker-compose.yml NEO4J_AUTH line.
 * Returns null if not found.
 */
export function extractPasswordFromCompose(composePath: string): string | null {
  const content = readFileSync(composePath, "utf-8");
  return extractPasswordFromComposeContent(content);
}

/**
 * Extract Neo4j password from docker-compose.yml content (for testability).
 */
export function extractPasswordFromComposeContent(content: string): string | null {
  // Match NEO4J_AUTH: neo4j/PASSWORD or NEO4J_AUTH=neo4j/PASSWORD
  // In YAML it can appear as:
  //   NEO4J_AUTH: neo4j/password
  //   - NEO4J_AUTH=neo4j/password
  for (const line of content.split("\n")) {
    const trimmed = line.trim();

    // Format: NEO4J_AUTH: neo4j/password
    const colonMatch = trimmed.match(/^NEO4J_AUTH:\s*neo4j\/(.+)$/);
    if (colonMatch?.[1]) {
      return colonMatch[1].trim();
    }

    // Format: - NEO4J_AUTH=neo4j/password (in environment list)
    const dashMatch = trimmed.match(/^-?\s*NEO4J_AUTH=neo4j\/(.+)$/);
    if (dashMatch?.[1]) {
      return dashMatch[1].trim();
    }

    // Format: NEO4J_AUTH: "neo4j/password" (quoted)
    const quotedMatch = trimmed.match(/^NEO4J_AUTH:\s*['"]?neo4j\/([^'"]+)['"]?$/);
    if (quotedMatch?.[1]) {
      return quotedMatch[1].trim();
    }
  }
  return null;
}

/**
 * Determine the Neo4j password from available sources.
 * Priority: docker-compose.yml > .env > default
 */
export function resolvePassword(
  envVars: Record<string, string>,
  composePassword: string | null,
): string {
  if (composePassword) return composePassword;
  if (envVars["NEO4J_PASSWORD"]) return envVars["NEO4J_PASSWORD"];
  return "memory_pass_2024";
}

// ─── Docker Compose generation for v3 ─────────────────────

interface V3ComposeConfig {
  neo4jPassword: string;
  enableQdrant: boolean;
  embeddingProvider: "builtin" | "ollama";
  ollamaUrl?: string;
  ollamaModel?: string;
}

function generateV3DockerCompose(cfg: V3ComposeConfig): string {
  let qdrantBlock = "";
  if (cfg.enableQdrant) {
    qdrantBlock = `
  qdrant:
    image: qdrant/qdrant:latest
    container_name: claude-memory-qdrant
    ports:
      - "6333:6333"
    volumes:
      - ./data/qdrant:/qdrant/storage
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "sh", "-c", "wget -qO- http://localhost:6333/healthz || exit 1"]
      interval: 10s
      timeout: 5s
      retries: 5
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
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "cypher-shell", "-u", "neo4j", "-p", "${cfg.neo4jPassword}", "RETURN 1"]
      interval: 10s
      timeout: 5s
      retries: 5
${qdrantBlock}`;
}

// ─── Config.json generation ────────────────────────────────

interface V3Config {
  version: number;
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
    ollamaUrl?: string;
  };
}

function generateV3Config(
  dataDir: string,
  envVars: Record<string, string>,
  password: string,
): V3Config {
  const provider = (envVars["EMBEDDING_PROVIDER"] ?? "builtin") as "builtin" | "ollama";
  const dimStr = envVars["EMBEDDING_DIM"];
  const defaultDim = provider === "ollama" ? 768 : 384;
  const dimension = dimStr ? parseInt(dimStr, 10) : defaultDim;

  const model =
    provider === "ollama"
      ? (envVars["OLLAMA_MODEL"] ?? "nomic-embed-text")
      : "all-MiniLM-L6-v2";

  const config: V3Config = {
    version: 3,
    dataDir,
    neo4j: {
      uri: envVars["NEO4J_URI"] ?? "bolt://localhost:7687",
      user: envVars["NEO4J_USER"] ?? "neo4j",
      password,
    },
    qdrant: {
      url: envVars["QDRANT_URL"] ?? "http://localhost:6333",
      collection: envVars["QDRANT_COLLECTION"] ?? "semantic_memory_facts",
    },
    embeddings: {
      provider,
      model,
      dimension,
    },
  };

  if (provider === "ollama" && envVars["OLLAMA_URL"]) {
    config.embeddings.ollamaUrl = envVars["OLLAMA_URL"];
  }

  return config;
}

// ─── Helpers ───────────────────────────────────────────────

function waitForNeo4j(maxWaitSec: number): boolean {
  console.error("  Waiting for Neo4j to be ready...");
  const deadline = Date.now() + maxWaitSec * 1000;
  while (Date.now() < deadline) {
    try {
      const status = execSync(
        "docker inspect --format='{{.State.Health.Status}}' claude-memory-neo4j",
        { timeout: 5000, stdio: "pipe" },
      )
        .toString()
        .trim();
      if (status === "healthy") return true;
    } catch {
      // container not ready yet
    }
    execSync("sleep 2");
  }
  return false;
}

function waitForQdrant(maxWaitSec: number): boolean {
  console.error("  Waiting for Qdrant to be ready...");
  const deadline = Date.now() + maxWaitSec * 1000;
  while (Date.now() < deadline) {
    try {
      const status = execSync(
        "docker inspect --format='{{.State.Health.Status}}' claude-memory-qdrant",
        { timeout: 5000, stdio: "pipe" },
      )
        .toString()
        .trim();
      if (status === "healthy") return true;
    } catch {
      // container not ready yet
    }
    execSync("sleep 2");
  }
  return false;
}

// ─── Fact schema migration ─────────────────────────────────

async function migrateFactSchema(qdrantUrl: string, collection: string): Promise<void> {
  const { QdrantClient } = await import("@qdrant/js-client-rest");
  const client = new QdrantClient({ url: qdrantUrl });

  const now = new Date().toISOString();

  // Scroll through all points and add v3 fields
  let offset: number | undefined;
  let total = 0;

  for (;;) {
    const result = await client.scroll(collection, {
      limit: 100,
      offset,
      with_payload: true,
      with_vector: false,
    });

    if (result.points.length === 0) break;

    const updates: Array<{
      id: number;
      payload: Record<string, unknown>;
    }> = [];

    for (const point of result.points) {
      const payload = point.payload as Record<string, unknown> | null;
      // Only add v3 fields if they are missing
      if (payload && payload["confidence"] === undefined) {
        const createdAt = (payload["created_at"] as string) ?? now;
        updates.push({
          id: point.id as number,
          payload: {
            confidence: 1.0,
            last_validated: now,
            version: null,
            valid_from: createdAt,
            valid_until: null,
            superseded_by: null,
          },
        });
      }
    }

    // Batch set payload
    if (updates.length > 0) {
      for (const update of updates) {
        await client.setPayload(collection, {
          payload: update.payload,
          points: [update.id],
        });
      }
      total += updates.length;
      console.error(`  Migrated ${total} facts with v3 fields...`);
    }

    if (!result.next_page_offset) break;
    offset = result.next_page_offset as number;
  }

  console.error(`  Fact schema migration complete: ${total} facts updated.`);
}

async function createQdrantV3Indexes(qdrantUrl: string, collection: string): Promise<void> {
  const { QdrantClient } = await import("@qdrant/js-client-rest");
  const client = new QdrantClient({ url: qdrantUrl });

  const indexes: Array<{ field: string; type: "keyword" | "float" | "datetime" }> = [
    { field: "confidence", type: "float" },
    { field: "last_validated", type: "datetime" },
    { field: "valid_from", type: "datetime" },
    { field: "valid_until", type: "datetime" },
    { field: "superseded_by", type: "keyword" },
    { field: "version", type: "keyword" },
  ];

  for (const { field, type } of indexes) {
    try {
      await client.createPayloadIndex(collection, {
        field_name: field,
        field_schema: type,
      });
    } catch (err) {
      // Index already exists — OK
      if (!String(err).includes("already exists")) {
        console.error(`  Warning: failed to create index for ${field}: ${err}`);
      }
    }
  }

  console.error("  Qdrant v3 payload indexes created.");
}

// ─── Update .claude.json ──────────────────────────────────

function updateClaudeJson(configJsonPath: string): void {
  const claudeJsonPath = join(homedir(), ".claude.json");

  let claudeConfig: Record<string, unknown> = {};
  if (existsSync(claudeJsonPath)) {
    claudeConfig = JSON.parse(readFileSync(claudeJsonPath, "utf-8")) as Record<string, unknown>;
  }

  const npxPkg = `semantic-memory-mcp@${PKG_VERSION}`;

  const mcpServers = (claudeConfig["mcpServers"] ?? {}) as Record<string, unknown>;
  mcpServers["semantic-memory"] = {
    type: "stdio",
    command: "npx",
    args: ["-y", npxPkg],
    env: {
      SEMANTIC_MEMORY_CONFIG: configJsonPath,
    },
  };
  claudeConfig["mcpServers"] = mcpServers;

  writeFileSync(claudeJsonPath, JSON.stringify(claudeConfig, null, 2) + "\n");
  console.error(`  Updated ~/.claude.json with SEMANTIC_MEMORY_CONFIG`);
}

// ─── Main migration function ──────────────────────────────

export interface MigrateV2Options {
  dataDir: string;
  rl?: ReturnType<typeof createInterface>;
  skipConfirm?: boolean;   // for testing
  skipDocker?: boolean;    // for testing
  skipClaudeJson?: boolean; // for testing
}

export async function migrateV2(opts: MigrateV2Options): Promise<void> {
  const { dataDir } = opts;
  const envPath = join(dataDir, ".env");
  const composePath = join(dataDir, "docker-compose.yml");
  const configJsonPath = join(dataDir, "config.json");
  const backupPath = join(dataDir, ".env.v2.bak");

  // 1. Parse .env
  if (!existsSync(envPath)) {
    throw new Error(`No .env found at ${envPath}`);
  }

  const envVars = parseEnvFile(envPath);

  // 2. Extract password from compose (if exists)
  let composePassword: string | null = null;
  if (existsSync(composePath)) {
    composePassword = extractPasswordFromCompose(composePath);
  }

  const password = resolvePassword(envVars, composePassword);

  // 3. Detect if Qdrant was enabled in v2
  const hadQdrant = !!envVars["QDRANT_URL"];

  // 4. Show migration plan
  console.error("\n  Migrating v2 → v3. Password, data, embeddings preserved.");
  if (!hadQdrant) {
    console.error("  Adding Qdrant (required in v3).");
  }

  // 5. Single confirmation
  if (!opts.skipConfirm) {
    const rl =
      opts.rl ??
      createInterface({ input: process.stdin, output: process.stdout });
    const ownRl = !opts.rl;
    try {
      const answer = await rl.question("  Proceed? [Y/n]: ");
      const trimmed = answer.trim().toLowerCase();
      if (trimmed === "n" || trimmed === "no") {
        console.error("  Migration cancelled.");
        return;
      }
    } finally {
      if (ownRl) rl.close();
    }
  }

  // 6. Generate config.json
  const v3Config = generateV3Config(dataDir, envVars, password);
  writeFileSync(configJsonPath, JSON.stringify(v3Config, null, 2) + "\n");
  console.error(`  Generated ${configJsonPath}`);

  // 7. Regenerate docker-compose.yml
  mkdirSync(join(dataDir, "data"), { recursive: true });
  const compose = generateV3DockerCompose({
    neo4jPassword: password,
    enableQdrant: true, // always enabled in v3
    embeddingProvider: v3Config.embeddings.provider,
    ollamaUrl: v3Config.embeddings.ollamaUrl,
    ollamaModel:
      v3Config.embeddings.provider === "ollama"
        ? v3Config.embeddings.model
        : undefined,
  });
  writeFileSync(composePath, compose);
  console.error(`  Generated ${composePath}`);

  if (!opts.skipDocker) {
    // 8. docker compose up -d
    console.error("\n  Starting containers...");
    try {
      execSync(`docker compose -f ${composePath} up -d`, {
        timeout: 120000,
        stdio: "pipe",
      });
    } catch (err) {
      throw new Error(
        `Failed to start containers. Run manually:\n  cd ${dataDir} && docker compose up -d\n` +
          (err instanceof Error ? err.message : String(err)),
      );
    }

    // Wait for services
    if (!waitForNeo4j(60)) {
      console.error(
        "  Warning: Neo4j did not become healthy in time. Check: docker logs claude-memory-neo4j",
      );
    } else {
      console.error("  Neo4j is ready.");
    }

    if (!waitForQdrant(30)) {
      console.error(
        "  Warning: Qdrant did not become healthy in time. Check: docker logs claude-memory-qdrant",
      );
    } else {
      console.error("  Qdrant is ready.");
    }

    // 9. Fact schema migration — add v3 fields to existing Qdrant points
    const qdrantUrl = v3Config.qdrant.url;
    const collection = v3Config.qdrant.collection;

    if (hadQdrant) {
      try {
        console.error("\n  Upgrading fact schema...");
        await migrateFactSchema(qdrantUrl, collection);
        await createQdrantV3Indexes(qdrantUrl, collection);
      } catch (err) {
        console.error(
          `  Warning: Fact schema migration failed: ${err instanceof Error ? err.message : err}`,
        );
        console.error(
          "  You can run this later manually with: npx semantic-memory-mcp migrate-qdrant",
        );
      }
    }

    // 10. If Qdrant was missing in v2, run migrate-qdrant to populate vectors
    if (!hadQdrant) {
      try {
        console.error("\n  Populating Qdrant from Neo4j...");
        // Set env vars so getConfig() works for migrate-qdrant
        process.env["NEO4J_URI"] = v3Config.neo4j.uri;
        process.env["NEO4J_USER"] = v3Config.neo4j.user;
        process.env["NEO4J_PASSWORD"] = v3Config.neo4j.password;
        process.env["QDRANT_URL"] = v3Config.qdrant.url;
        process.env["QDRANT_COLLECTION"] = v3Config.qdrant.collection;
        process.env["EMBEDDING_PROVIDER"] = v3Config.embeddings.provider;
        process.env["EMBEDDING_DIM"] = String(v3Config.embeddings.dimension);
        if (v3Config.embeddings.ollamaUrl) {
          process.env["OLLAMA_URL"] = v3Config.embeddings.ollamaUrl;
        }
        if (v3Config.embeddings.provider === "ollama") {
          process.env["OLLAMA_MODEL"] = v3Config.embeddings.model;
        }

        const { runMigrateQdrant } = await import("./migrate-qdrant.js");
        await runMigrateQdrant({ reconcile: false, recreate: false, reEmbed: true });

        // Create v3 indexes after migration
        await createQdrantV3Indexes(qdrantUrl, collection);
      } catch (err) {
        console.error(
          `  Warning: Qdrant migration failed: ${err instanceof Error ? err.message : err}`,
        );
        console.error(
          "  You can run this later with: npx semantic-memory-mcp migrate-qdrant --re-embed",
        );
      }
    }
  }

  // 11. Rename .env → .env.v2.bak
  if (existsSync(envPath) && !existsSync(backupPath)) {
    renameSync(envPath, backupPath);
    console.error(`  Renamed .env → .env.v2.bak`);
  } else if (existsSync(envPath) && existsSync(backupPath)) {
    // .env.v2.bak already exists (re-run) — just rename
    renameSync(envPath, backupPath);
    console.error(`  Renamed .env → .env.v2.bak (overwritten previous backup)`);
  }

  // 12. Update ~/.claude.json
  if (!opts.skipClaudeJson) {
    updateClaudeJson(configJsonPath);
  }

  console.error("\n  V2 → V3 migration complete!");
  console.error(`  Data dir: ${dataDir}`);
  console.error("  Restart Claude Code to activate.\n");
}
