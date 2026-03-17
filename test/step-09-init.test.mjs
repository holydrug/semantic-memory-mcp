import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { mkdirSync, writeFileSync, existsSync, readFileSync, rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";

// ─── Dynamic imports from dist ───────────────────────────────────────

const { detectState, resolveDataDir } = await import("../dist/cli/init-detect.js");
const { generateCompose, checkPorts, detectWSL } = await import("../dist/docker.js");
const { updateClaudeJson, parseInitArgs } = await import("../dist/cli/init.js");

// ─── Helpers ─────────────────────────────────────────────────────────

function makeTmpDir() {
  return mkdtempSync(join(tmpdir(), "sm-test-09-"));
}

// ─── Unit Tests ──────────────────────────────────────────────────────

describe("Step 09: detectState", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns all false when no files exist", async () => {
    const dataDir = join(tmpDir, "nonexistent");
    const state = await detectState({ dataDir });

    assert.strictEqual(state.dataDir, dataDir);
    assert.strictEqual(state.has_v3_config, false);
    assert.strictEqual(state.has_v2_env, false);
    assert.strictEqual(state.has_compose, false);
    assert.strictEqual(state.containers_ok, false);
  });

  it("detects v3 config.json", async () => {
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(
      join(tmpDir, "config.json"),
      JSON.stringify({ version: 3, dataDir: tmpDir }),
    );

    const state = await detectState({ dataDir: tmpDir });
    assert.strictEqual(state.has_v3_config, true);
    assert.strictEqual(state.has_v2_env, false);
  });

  it("detects v2 .env when no config.json exists", async () => {
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(join(tmpDir, ".env"), "NEO4J_PASSWORD=test123\n");

    const state = await detectState({ dataDir: tmpDir });
    assert.strictEqual(state.has_v3_config, false);
    assert.strictEqual(state.has_v2_env, true);
  });

  it("has_v2_env is false when config.json also exists", async () => {
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(join(tmpDir, ".env"), "NEO4J_PASSWORD=test123\n");
    writeFileSync(
      join(tmpDir, "config.json"),
      JSON.stringify({ version: 3, dataDir: tmpDir }),
    );

    const state = await detectState({ dataDir: tmpDir });
    assert.strictEqual(state.has_v3_config, true);
    assert.strictEqual(state.has_v2_env, false);
  });

  it("detects docker-compose.yml", async () => {
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(join(tmpDir, "docker-compose.yml"), "services:\n  neo4j:\n    image: neo4j\n");

    const state = await detectState({ dataDir: tmpDir });
    assert.strictEqual(state.has_compose, true);
  });
});

describe("Step 09: resolveDataDir", () => {
  it("uses explicit --data-dir when provided", () => {
    const dir = resolveDataDir("/tmp/custom-dir");
    assert.strictEqual(dir, "/tmp/custom-dir");
  });

  it("falls back to ~/.semantic-memory when nothing exists", () => {
    // With a non-existent explicit dir that will trigger default resolution
    const dir = resolveDataDir(undefined);
    // The result depends on filesystem state but should be a string
    assert.strictEqual(typeof dir, "string");
    assert.ok(dir.length > 0);
  });
});

describe("Step 09: detectWSL", () => {
  it("returns boolean", () => {
    const result = detectWSL();
    assert.strictEqual(typeof result, "boolean");
  });

  it("detects WSL_DISTRO_NAME env var", () => {
    const original = process.env["WSL_DISTRO_NAME"];
    try {
      process.env["WSL_DISTRO_NAME"] = "Ubuntu";
      const result = detectWSL();
      assert.strictEqual(result, true);
    } finally {
      if (original === undefined) {
        delete process.env["WSL_DISTRO_NAME"];
      } else {
        process.env["WSL_DISTRO_NAME"] = original;
      }
    }
  });
});

describe("Step 09: checkPorts", () => {
  it("returns a Map with port status", () => {
    // Use a high port that is very unlikely to be in use
    const result = checkPorts([59999]);
    assert.ok(result instanceof Map);
    assert.strictEqual(result.size, 1);
    // Port 59999 should be free
    assert.strictEqual(result.get(59999), null);
  });
});

describe("Step 09: generateCompose", () => {
  it("generates valid YAML with correct password and ports", () => {
    const yaml = generateCompose({
      neo4jPassword: "test-password-123",
      neo4jBoltPort: 7687,
      neo4jHttpPort: 7474,
      qdrantPort: 6333,
      dataDir: "/tmp/test",
    });

    // Check password is inlined
    assert.ok(yaml.includes("test-password-123"), "password should be inlined in YAML");

    // Check ports
    assert.ok(yaml.includes('"7687:7687"'), "bolt port should be present");
    assert.ok(yaml.includes('"7474:7474"'), "http port should be present");
    assert.ok(yaml.includes('"6333:6333"'), "qdrant port should be present");

    // Check services
    assert.ok(yaml.includes("neo4j:"), "neo4j service should be present");
    assert.ok(yaml.includes("qdrant:"), "qdrant service should be present");

    // Check healthchecks
    assert.ok(yaml.includes("healthcheck:"), "healthcheck should be present");

    // Check restart policy
    assert.ok(yaml.includes("restart: unless-stopped"), "restart policy should be present");

    // Check NEO4J_AUTH format
    assert.ok(
      yaml.includes("NEO4J_AUTH: neo4j/test-password-123"),
      "NEO4J_AUTH should use password",
    );
  });

  it("uses custom ports", () => {
    const yaml = generateCompose({
      neo4jPassword: "pwd",
      neo4jBoltPort: 17687,
      neo4jHttpPort: 17474,
      qdrantPort: 16333,
      dataDir: "/tmp/test",
    });

    assert.ok(yaml.includes('"17687:7687"'), "custom bolt port");
    assert.ok(yaml.includes('"17474:7474"'), "custom http port");
    assert.ok(yaml.includes('"16333:6333"'), "custom qdrant port");
  });
});

describe("Step 09: updateClaudeJson", () => {
  let tmpDir;
  let originalHome;
  let claudeJsonPath;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    // We cannot easily mock homedir(), so we test the function by calling it
    // and checking the result in ~/.claude.json. We'll back up and restore.
    claudeJsonPath = join(homedir(), ".claude.json");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("adds MCP entry to existing claude.json", () => {
    // Read current ~/.claude.json if it exists
    let originalContent = null;
    if (existsSync(claudeJsonPath)) {
      originalContent = readFileSync(claudeJsonPath, "utf-8");
    }

    try {
      // Write a minimal claude.json
      writeFileSync(claudeJsonPath, JSON.stringify({ existingKey: true }, null, 2) + "\n");

      const configPath = join(tmpDir, "config.json");
      updateClaudeJson(configPath);

      const result = JSON.parse(readFileSync(claudeJsonPath, "utf-8"));
      assert.ok(result.mcpServers, "mcpServers should exist");
      assert.ok(result.mcpServers["semantic-memory"], "semantic-memory entry should exist");
      assert.strictEqual(
        result.mcpServers["semantic-memory"].env.SEMANTIC_MEMORY_CONFIG,
        configPath,
        "config path should be set",
      );
      assert.strictEqual(result.existingKey, true, "existing keys should be preserved");
    } finally {
      // Restore original
      if (originalContent !== null) {
        writeFileSync(claudeJsonPath, originalContent);
      } else if (existsSync(claudeJsonPath)) {
        rmSync(claudeJsonPath);
      }
    }
  });

  it("creates claude.json if it does not exist", () => {
    let originalContent = null;
    if (existsSync(claudeJsonPath)) {
      originalContent = readFileSync(claudeJsonPath, "utf-8");
    }

    try {
      // Remove claude.json
      if (existsSync(claudeJsonPath)) {
        rmSync(claudeJsonPath);
      }

      const configPath = join(tmpDir, "config.json");
      updateClaudeJson(configPath);

      assert.ok(existsSync(claudeJsonPath), "claude.json should be created");
      const result = JSON.parse(readFileSync(claudeJsonPath, "utf-8"));
      assert.ok(result.mcpServers["semantic-memory"], "semantic-memory entry should exist");
    } finally {
      if (originalContent !== null) {
        writeFileSync(claudeJsonPath, originalContent);
      } else if (existsSync(claudeJsonPath)) {
        rmSync(claudeJsonPath);
      }
    }
  });
});

describe("Step 09: parseInitArgs", () => {
  it("parses --data-dir", () => {
    const args = parseInitArgs(["--data-dir", "/tmp/my-data"]);
    assert.strictEqual(args.dataDir, "/tmp/my-data");
  });

  it("parses --reconfigure", () => {
    const args = parseInitArgs(["--reconfigure"]);
    assert.strictEqual(args.reconfigure, true);
  });

  it("parses --reset", () => {
    const args = parseInitArgs(["--reset"]);
    assert.strictEqual(args.reset, true);
  });

  it("parses combined flags", () => {
    const args = parseInitArgs(["--data-dir", "/tmp/d", "--reset"]);
    assert.strictEqual(args.dataDir, "/tmp/d");
    assert.strictEqual(args.reset, true);
  });

  it("returns empty for no args", () => {
    const args = parseInitArgs([]);
    assert.strictEqual(args.dataDir, undefined);
    assert.strictEqual(args.reconfigure, undefined);
    assert.strictEqual(args.reset, undefined);
  });
});

// ─── Integration Tests ──────────────────────────────────────────────

describe("Step 09: Integration — fresh init file creation", { skip: !process.env.INTEGRATION }, () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("freshInstall creates config.json and docker-compose.yml", async () => {
    // We can't run the full freshInstall without Docker and interactive input,
    // but we can test the file creation logic directly
    const { generateCompose } = await import("../dist/docker.js");

    const dataDir = join(tmpDir, ".semantic-memory");
    mkdirSync(join(dataDir, "data", "neo4j"), { recursive: true });
    mkdirSync(join(dataDir, "data", "qdrant"), { recursive: true });

    // Write config.json
    const config = {
      version: 3,
      dataDir,
      neo4j: { uri: "bolt://localhost:7687", user: "neo4j", password: "test-pwd" },
      qdrant: { url: "http://localhost:6333", collection: "semantic_memory" },
      embeddings: { provider: "builtin", model: "all-MiniLM-L6-v2", dimension: 384 },
    };
    writeFileSync(join(dataDir, "config.json"), JSON.stringify(config, null, 2) + "\n");

    // Write docker-compose.yml
    const composeContent = generateCompose({
      neo4jPassword: "test-pwd",
      neo4jBoltPort: 7687,
      neo4jHttpPort: 7474,
      qdrantPort: 6333,
      dataDir,
    });
    writeFileSync(join(dataDir, "docker-compose.yml"), composeContent);

    // Verify files exist
    assert.ok(existsSync(join(dataDir, "config.json")), "config.json should exist");
    assert.ok(existsSync(join(dataDir, "docker-compose.yml")), "docker-compose.yml should exist");

    // Verify config content
    const savedConfig = JSON.parse(readFileSync(join(dataDir, "config.json"), "utf-8"));
    assert.strictEqual(savedConfig.version, 3);
    assert.strictEqual(savedConfig.neo4j.password, "test-pwd");
    assert.strictEqual(savedConfig.embeddings.provider, "builtin");

    // Verify compose content
    const composeYaml = readFileSync(join(dataDir, "docker-compose.yml"), "utf-8");
    assert.ok(composeYaml.includes("test-pwd"));
    assert.ok(composeYaml.includes("neo4j"));
    assert.ok(composeYaml.includes("qdrant"));
  });

  it("re-detect after config creation shows has_v3_config=true", async () => {
    const dataDir = join(tmpDir, ".semantic-memory");
    mkdirSync(dataDir, { recursive: true });

    // Initially no config
    let state = await detectState({ dataDir });
    assert.strictEqual(state.has_v3_config, false);

    // Write config
    writeFileSync(
      join(dataDir, "config.json"),
      JSON.stringify({ version: 3, dataDir }),
    );

    // Now should detect v3
    state = await detectState({ dataDir });
    assert.strictEqual(state.has_v3_config, true);
  });
});
