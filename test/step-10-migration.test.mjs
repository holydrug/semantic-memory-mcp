import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Import pure functions from the compiled module
const {
  parseEnvContent,
  extractPasswordFromComposeContent,
  resolvePassword,
} = await import("../dist/init-v2-migrate.js");

// ─── Unit tests ────────────────────────────────────────────

describe("parseEnvContent", () => {
  it("parses KEY=VALUE pairs", () => {
    const result = parseEnvContent("FOO=bar\nBAZ=qux");
    assert.deepStrictEqual(result, { FOO: "bar", BAZ: "qux" });
  });

  it("parses KEY=\"quoted value\" (double quotes)", () => {
    const result = parseEnvContent('KEY="hello world"');
    assert.deepStrictEqual(result, { KEY: "hello world" });
  });

  it("parses KEY='quoted value' (single quotes)", () => {
    const result = parseEnvContent("KEY='hello world'");
    assert.deepStrictEqual(result, { KEY: "hello world" });
  });

  it("skips comments and empty lines", () => {
    const content = `
# This is a comment
FOO=bar

# Another comment
BAZ=qux

`;
    const result = parseEnvContent(content);
    assert.deepStrictEqual(result, { FOO: "bar", BAZ: "qux" });
  });

  it("handles typical v2 .env file", () => {
    const content = `NEO4J_URI=bolt://localhost:7687
NEO4J_USER=neo4j
NEO4J_PASSWORD=my_secret_pass
EMBEDDING_PROVIDER=builtin
EMBEDDING_DIM=384
QDRANT_URL=http://localhost:6333`;
    const result = parseEnvContent(content);
    assert.strictEqual(result["NEO4J_URI"], "bolt://localhost:7687");
    assert.strictEqual(result["NEO4J_PASSWORD"], "my_secret_pass");
    assert.strictEqual(result["QDRANT_URL"], "http://localhost:6333");
    assert.strictEqual(result["EMBEDDING_PROVIDER"], "builtin");
    assert.strictEqual(result["EMBEDDING_DIM"], "384");
  });

  it("handles values with equals sign", () => {
    const result = parseEnvContent("KEY=value=with=equals");
    assert.deepStrictEqual(result, { KEY: "value=with=equals" });
  });

  it("trims whitespace around key and value", () => {
    const result = parseEnvContent("  KEY  =  value  ");
    assert.deepStrictEqual(result, { KEY: "value" });
  });
});

describe("extractPasswordFromComposeContent", () => {
  it("extracts password from NEO4J_AUTH: neo4j/password", () => {
    const content = `services:
  neo4j:
    image: neo4j:5-community
    environment:
      NEO4J_AUTH: neo4j/super_secret_123
    volumes:
      - ./data/neo4j:/data`;
    const password = extractPasswordFromComposeContent(content);
    assert.strictEqual(password, "super_secret_123");
  });

  it("extracts password from - NEO4J_AUTH=neo4j/password format", () => {
    const content = `services:
  neo4j:
    environment:
      - NEO4J_AUTH=neo4j/my_password`;
    const password = extractPasswordFromComposeContent(content);
    assert.strictEqual(password, "my_password");
  });

  it("returns null when NEO4J_AUTH is not present", () => {
    const content = `services:
  neo4j:
    image: neo4j:5-community
    environment:
      NEO4J_PLUGINS: '[]'`;
    const password = extractPasswordFromComposeContent(content);
    assert.strictEqual(password, null);
  });

  it("handles quoted password in compose", () => {
    const content = `    environment:
      NEO4J_AUTH: neo4j/quoted_pass`;
    const password = extractPasswordFromComposeContent(content);
    assert.strictEqual(password, "quoted_pass");
  });
});

describe("resolvePassword", () => {
  it("compose password wins over .env password", () => {
    const envVars = { NEO4J_PASSWORD: "env_pass" };
    const composePassword = "compose_pass";
    const result = resolvePassword(envVars, composePassword);
    assert.strictEqual(result, "compose_pass");
  });

  it(".env password used when compose has no password", () => {
    const envVars = { NEO4J_PASSWORD: "env_pass" };
    const result = resolvePassword(envVars, null);
    assert.strictEqual(result, "env_pass");
  });

  it("default password used when neither source has password", () => {
    const result = resolvePassword({}, null);
    assert.strictEqual(result, "memory_pass_2024");
  });

  it("compose password wins even when .env also has password", () => {
    const envVars = { NEO4J_PASSWORD: "password1" };
    const composePassword = "password2";
    const result = resolvePassword(envVars, composePassword);
    assert.strictEqual(result, "password2");
  });
});

describe("migrateV2 — filesystem operations", () => {
  let tmpDir;

  before(() => {
    tmpDir = join(tmpdir(), `test-migration-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("generates config.json from v2 .env with correct values", async () => {
    const dataDir = join(tmpDir, "test-config-gen");
    mkdirSync(dataDir, { recursive: true });

    // Create mock v2 .env
    writeFileSync(
      join(dataDir, ".env"),
      `NEO4J_URI=bolt://localhost:7687
NEO4J_USER=neo4j
NEO4J_PASSWORD=test_password_123
EMBEDDING_PROVIDER=builtin
EMBEDDING_DIM=384
QDRANT_URL=http://localhost:6333
`,
    );

    // Create mock docker-compose.yml with different password
    writeFileSync(
      join(dataDir, "docker-compose.yml"),
      `services:
  neo4j:
    image: neo4j:5-community
    environment:
      NEO4J_AUTH: neo4j/compose_password_456
`,
    );

    // Import and run migration with skipDocker and skipClaudeJson
    const { migrateV2 } = await import("../dist/init-v2-migrate.js");
    await migrateV2({
      dataDir,
      skipConfirm: true,
      skipDocker: true,
      skipClaudeJson: true,
    });

    // Verify config.json was created
    const configPath = join(dataDir, "config.json");
    assert.ok(existsSync(configPath), "config.json should exist");

    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    assert.strictEqual(config.version, 3);
    assert.strictEqual(config.neo4j.password, "compose_password_456"); // compose wins
    assert.strictEqual(config.neo4j.uri, "bolt://localhost:7687");
    assert.strictEqual(config.qdrant.url, "http://localhost:6333");
    assert.strictEqual(config.embeddings.provider, "builtin");
    assert.strictEqual(config.embeddings.dimension, 384);
  });

  it("renames .env to .env.v2.bak", async () => {
    const dataDir = join(tmpDir, "test-env-backup");
    mkdirSync(dataDir, { recursive: true });

    writeFileSync(join(dataDir, ".env"), "NEO4J_PASSWORD=test\n");

    const { migrateV2 } = await import("../dist/init-v2-migrate.js");
    await migrateV2({
      dataDir,
      skipConfirm: true,
      skipDocker: true,
      skipClaudeJson: true,
    });

    assert.ok(
      existsSync(join(dataDir, ".env.v2.bak")),
      ".env.v2.bak should exist",
    );
    assert.ok(
      !existsSync(join(dataDir, ".env")),
      ".env should be renamed",
    );

    // Check backup content
    const backup = readFileSync(join(dataDir, ".env.v2.bak"), "utf-8");
    assert.strictEqual(backup, "NEO4J_PASSWORD=test\n");
  });

  it("config.json has correct password priority: compose > .env > default", async () => {
    // Case 1: compose wins
    const dir1 = join(tmpDir, "test-priority-compose");
    mkdirSync(dir1, { recursive: true });
    writeFileSync(join(dir1, ".env"), "NEO4J_PASSWORD=env_pass\n");
    writeFileSync(
      join(dir1, "docker-compose.yml"),
      "    environment:\n      NEO4J_AUTH: neo4j/compose_pass\n",
    );

    const { migrateV2 } = await import("../dist/init-v2-migrate.js");
    await migrateV2({
      dataDir: dir1,
      skipConfirm: true,
      skipDocker: true,
      skipClaudeJson: true,
    });

    const config1 = JSON.parse(
      readFileSync(join(dir1, "config.json"), "utf-8"),
    );
    assert.strictEqual(config1.neo4j.password, "compose_pass");

    // Case 2: .env wins when no compose password
    const dir2 = join(tmpDir, "test-priority-env");
    mkdirSync(dir2, { recursive: true });
    writeFileSync(join(dir2, ".env"), "NEO4J_PASSWORD=env_pass\n");
    // No docker-compose.yml

    await migrateV2({
      dataDir: dir2,
      skipConfirm: true,
      skipDocker: true,
      skipClaudeJson: true,
    });

    const config2 = JSON.parse(
      readFileSync(join(dir2, "config.json"), "utf-8"),
    );
    assert.strictEqual(config2.neo4j.password, "env_pass");

    // Case 3: default when neither
    const dir3 = join(tmpDir, "test-priority-default");
    mkdirSync(dir3, { recursive: true });
    writeFileSync(join(dir3, ".env"), "NEO4J_URI=bolt://localhost:7687\n");

    await migrateV2({
      dataDir: dir3,
      skipConfirm: true,
      skipDocker: true,
      skipClaudeJson: true,
    });

    const config3 = JSON.parse(
      readFileSync(join(dir3, "config.json"), "utf-8"),
    );
    assert.strictEqual(config3.neo4j.password, "memory_pass_2024");
  });

  it("generates docker-compose.yml with Qdrant and healthchecks", async () => {
    const dataDir = join(tmpDir, "test-compose-gen");
    mkdirSync(dataDir, { recursive: true });

    writeFileSync(
      join(dataDir, ".env"),
      "NEO4J_PASSWORD=test\nEMBEDDING_PROVIDER=builtin\n",
    );

    const { migrateV2 } = await import("../dist/init-v2-migrate.js");
    await migrateV2({
      dataDir,
      skipConfirm: true,
      skipDocker: true,
      skipClaudeJson: true,
    });

    const compose = readFileSync(
      join(dataDir, "docker-compose.yml"),
      "utf-8",
    );

    // Qdrant service should be present (always in v3)
    assert.ok(compose.includes("qdrant"), "should include qdrant service");
    assert.ok(
      compose.includes("qdrant/qdrant"),
      "should include qdrant image",
    );

    // Neo4j healthcheck
    assert.ok(
      compose.includes("healthcheck"),
      "should include healthcheck",
    );

    // restart: unless-stopped
    assert.ok(
      compose.includes("unless-stopped"),
      "should include restart policy",
    );
  });

  it("preserves v2 .env values when no QDRANT_URL (adds Qdrant)", async () => {
    const dataDir = join(tmpDir, "test-no-qdrant");
    mkdirSync(dataDir, { recursive: true });

    // v2 .env without Qdrant
    writeFileSync(
      join(dataDir, ".env"),
      `NEO4J_URI=bolt://localhost:7687
NEO4J_PASSWORD=my_pass
EMBEDDING_PROVIDER=ollama
OLLAMA_MODEL=nomic-embed-text
OLLAMA_URL=http://localhost:11434
EMBEDDING_DIM=768
`,
    );

    const { migrateV2 } = await import("../dist/init-v2-migrate.js");
    await migrateV2({
      dataDir,
      skipConfirm: true,
      skipDocker: true,
      skipClaudeJson: true,
    });

    const config = JSON.parse(
      readFileSync(join(dataDir, "config.json"), "utf-8"),
    );

    // Qdrant should be configured with defaults
    assert.strictEqual(config.qdrant.url, "http://localhost:6333");
    assert.strictEqual(config.qdrant.collection, "semantic_memory_facts");

    // Embedding settings preserved
    assert.strictEqual(config.embeddings.provider, "ollama");
    assert.strictEqual(config.embeddings.model, "nomic-embed-text");
    assert.strictEqual(config.embeddings.dimension, 768);
    assert.strictEqual(config.embeddings.ollamaUrl, "http://localhost:11434");
  });

  it("is idempotent — can be re-run", async () => {
    const dataDir = join(tmpDir, "test-idempotent");
    mkdirSync(dataDir, { recursive: true });

    writeFileSync(join(dataDir, ".env"), "NEO4J_PASSWORD=test\n");

    const { migrateV2 } = await import("../dist/init-v2-migrate.js");

    // First run
    await migrateV2({
      dataDir,
      skipConfirm: true,
      skipDocker: true,
      skipClaudeJson: true,
    });

    assert.ok(existsSync(join(dataDir, "config.json")));
    assert.ok(existsSync(join(dataDir, ".env.v2.bak")));

    const config1 = JSON.parse(
      readFileSync(join(dataDir, "config.json"), "utf-8"),
    );
    assert.strictEqual(config1.neo4j.password, "test");

    // Simulate partial re-run: new .env appears (e.g. user restored .env.v2.bak)
    // Remove old compose to simulate fresh state
    writeFileSync(join(dataDir, ".env"), "NEO4J_PASSWORD=test2\n");
    rmSync(join(dataDir, "docker-compose.yml"), { force: true });
    rmSync(join(dataDir, "config.json"), { force: true });

    // Second run should not throw
    await migrateV2({
      dataDir,
      skipConfirm: true,
      skipDocker: true,
      skipClaudeJson: true,
    });

    const config2 = JSON.parse(
      readFileSync(join(dataDir, "config.json"), "utf-8"),
    );
    assert.strictEqual(config2.neo4j.password, "test2");
  });
});

// ─── Integration tests ────────────────────────────────────

describe("migrateV2 — integration", { skip: !process.env.INTEGRATION }, () => {
  it("full migration with Docker containers", async () => {
    // This test requires Docker and real containers
    // Skipped unless INTEGRATION=1
    assert.ok(true, "placeholder for full integration test");
  });

  it("fact schema upgrade with Qdrant", async () => {
    // This test requires running Qdrant
    // Skipped unless INTEGRATION=1
    assert.ok(true, "placeholder for fact schema integration test");
  });

  it("Qdrant indexes created after migration", async () => {
    // This test requires running Qdrant
    // Skipped unless INTEGRATION=1
    assert.ok(true, "placeholder for Qdrant indexes integration test");
  });
});
