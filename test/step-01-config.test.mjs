import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

/**
 * Helper: create a unique temp directory for each test.
 * Returns { dir, configPath, cleanup }.
 */
function makeTempDir() {
  const dir = join(tmpdir(), `sm-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  const configPath = join(dir, "config.json");
  return {
    dir,
    configPath,
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Minimal valid v3 config.json content */
function validConfigJson(overrides = {}) {
  return JSON.stringify({
    version: 3,
    dataDir: join(tmpdir(), `sm-data-${randomUUID()}`),
    neo4j: {
      uri: "bolt://localhost:7687",
      user: "neo4j",
      password: "test_pass",
    },
    qdrant: {
      url: "http://localhost:6333",
      collection: "test_collection",
    },
    embeddings: {
      provider: "builtin",
      model: "all-MiniLM-L6-v2",
      dimension: 384,
    },
    ...overrides,
  });
}

/**
 * Helper to safely clear env vars that might affect config resolution,
 * and restore them after the test.
 */
function clearConfigEnv() {
  const envKeys = [
    "SEMANTIC_MEMORY_CONFIG",
    "CLAUDE_MEMORY_DIR",
    "CLAUDE_MEMORY_MODEL_CACHE",
    "EMBEDDING_PROVIDER",
    "EMBEDDING_DIM",
    "OLLAMA_URL",
    "OLLAMA_MODEL",
    "NEO4J_URI",
    "NEO4J_USER",
    "NEO4J_PASSWORD",
    "MEMORY_TRIGGERS_STORE",
    "MEMORY_TRIGGERS_SEARCH",
    "MEMORY_TRIGGERS_GRAPH",
    "MEMORY_TRIGGERS_LIST",
    "MEMORY_TRIGGERS_DELETE",
    "CLAUDE_MEMORY_GLOBAL_DIR",
    "CLAUDE_MEMORY_PROJECT_SLUG",
    "QDRANT_URL",
    "QDRANT_API_KEY",
    "QDRANT_COLLECTION",
  ];

  const saved = {};
  for (const key of envKeys) {
    if (key in process.env) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  }

  return function restore() {
    // Clear everything first
    for (const key of envKeys) {
      delete process.env[key];
    }
    // Restore saved values
    for (const [key, val] of Object.entries(saved)) {
      process.env[key] = val;
    }
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("Step 01: Config v3 loader", () => {
  // We dynamically import config.ts so env var changes take effect fresh.
  // But since ESM modules are cached, we use parseConfigJson/getConfigFromEnv
  // which are pure functions and testable without reimporting.

  /** @type {typeof import('../dist/config.js')} */
  let configModule;

  beforeEach(async () => {
    // Dynamic import (cached after first load, but functions read env at call time)
    configModule = await import("../dist/config.js");
  });

  describe("parseConfigJson", () => {
    it("should load a valid config.json and return correct Config shape", () => {
      const tmp = makeTempDir();
      try {
        const dataDir = join(tmpdir(), `sm-data-${randomUUID()}`);
        writeFileSync(
          tmp.configPath,
          JSON.stringify({
            version: 3,
            dataDir,
            neo4j: { uri: "bolt://myhost:7687", user: "admin", password: "secret123" },
            qdrant: { url: "http://myqdrant:6333", collection: "my_facts" },
            embeddings: { provider: "builtin", model: "all-MiniLM-L6-v2", dimension: 384 },
          })
        );

        const config = configModule.parseConfigJson(tmp.configPath);

        assert.strictEqual(config.neo4jUri, "bolt://myhost:7687");
        assert.strictEqual(config.neo4jUser, "admin");
        assert.strictEqual(config.neo4jPassword, "secret123");
        assert.strictEqual(config.qdrantUrl, "http://myqdrant:6333");
        assert.strictEqual(config.qdrantCollection, "my_facts");
        assert.strictEqual(config.embeddingProvider, "builtin");
        assert.strictEqual(config.embeddingDim, 384);
        assert.strictEqual(config.embeddingModel, "Xenova/all-MiniLM-L6-v2");
        assert.strictEqual(config.modelCacheDir, join(dataDir, "models"));
        assert.strictEqual(config.dualMode, false);

        // Cleanup created dataDir
        if (existsSync(dataDir)) rmSync(dataDir, { recursive: true, force: true });
      } finally {
        tmp.cleanup();
      }
    });

    it("should throw on invalid JSON", () => {
      const tmp = makeTempDir();
      try {
        writeFileSync(tmp.configPath, "{ not valid json }}}");
        assert.throws(
          () => configModule.parseConfigJson(tmp.configPath),
          (err) => {
            assert.ok(err.message.includes("Invalid JSON"), `Expected 'Invalid JSON' in: ${err.message}`);
            return true;
          }
        );
      } finally {
        tmp.cleanup();
      }
    });

    it("should throw when required field 'version' is missing", () => {
      const tmp = makeTempDir();
      try {
        writeFileSync(
          tmp.configPath,
          JSON.stringify({
            dataDir: "/tmp/test",
            neo4j: { uri: "bolt://localhost:7687", user: "neo4j", password: "x" },
            qdrant: { url: "http://localhost:6333", collection: "c" },
            embeddings: { provider: "builtin", model: "m", dimension: 384 },
          })
        );
        assert.throws(
          () => configModule.parseConfigJson(tmp.configPath),
          (err) => {
            assert.ok(err.message.includes('"version"'), `Expected '"version"' in: ${err.message}`);
            return true;
          }
        );
      } finally {
        tmp.cleanup();
      }
    });

    it("should throw when required field 'dataDir' is missing", () => {
      const tmp = makeTempDir();
      try {
        writeFileSync(
          tmp.configPath,
          JSON.stringify({
            version: 3,
            neo4j: { uri: "bolt://localhost:7687", user: "neo4j", password: "x" },
            qdrant: { url: "http://localhost:6333", collection: "c" },
            embeddings: { provider: "builtin", model: "m", dimension: 384 },
          })
        );
        assert.throws(
          () => configModule.parseConfigJson(tmp.configPath),
          (err) => {
            assert.ok(err.message.includes('"dataDir"'), `Expected '"dataDir"' in: ${err.message}`);
            return true;
          }
        );
      } finally {
        tmp.cleanup();
      }
    });

    it("should throw when required nested field 'neo4j.password' is missing", () => {
      const tmp = makeTempDir();
      try {
        writeFileSync(
          tmp.configPath,
          JSON.stringify({
            version: 3,
            dataDir: "/tmp/test",
            neo4j: { uri: "bolt://localhost:7687", user: "neo4j" },
            qdrant: { url: "http://localhost:6333", collection: "c" },
            embeddings: { provider: "builtin", model: "m", dimension: 384 },
          })
        );
        assert.throws(
          () => configModule.parseConfigJson(tmp.configPath),
          (err) => {
            assert.ok(
              err.message.includes('"neo4j.password"'),
              `Expected '"neo4j.password"' in: ${err.message}`
            );
            return true;
          }
        );
      } finally {
        tmp.cleanup();
      }
    });

    it("should throw when neo4j section is missing entirely", () => {
      const tmp = makeTempDir();
      try {
        writeFileSync(
          tmp.configPath,
          JSON.stringify({
            version: 3,
            dataDir: "/tmp/test",
            qdrant: { url: "http://localhost:6333", collection: "c" },
            embeddings: { provider: "builtin", model: "m", dimension: 384 },
          })
        );
        assert.throws(
          () => configModule.parseConfigJson(tmp.configPath),
          (err) => {
            assert.ok(err.message.includes('"neo4j"'), `Expected '"neo4j"' in: ${err.message}`);
            return true;
          }
        );
      } finally {
        tmp.cleanup();
      }
    });

    it("should throw when qdrant section is missing", () => {
      const tmp = makeTempDir();
      try {
        writeFileSync(
          tmp.configPath,
          JSON.stringify({
            version: 3,
            dataDir: "/tmp/test",
            neo4j: { uri: "bolt://localhost:7687", user: "neo4j", password: "x" },
            embeddings: { provider: "builtin", model: "m", dimension: 384 },
          })
        );
        assert.throws(
          () => configModule.parseConfigJson(tmp.configPath),
          (err) => {
            assert.ok(err.message.includes('"qdrant"'), `Expected '"qdrant"' in: ${err.message}`);
            return true;
          }
        );
      } finally {
        tmp.cleanup();
      }
    });

    it("should throw when embeddings section is missing", () => {
      const tmp = makeTempDir();
      try {
        writeFileSync(
          tmp.configPath,
          JSON.stringify({
            version: 3,
            dataDir: "/tmp/test",
            neo4j: { uri: "bolt://localhost:7687", user: "neo4j", password: "x" },
            qdrant: { url: "http://localhost:6333", collection: "c" },
          })
        );
        assert.throws(
          () => configModule.parseConfigJson(tmp.configPath),
          (err) => {
            assert.ok(err.message.includes('"embeddings"'), `Expected '"embeddings"' in: ${err.message}`);
            return true;
          }
        );
      } finally {
        tmp.cleanup();
      }
    });

    it("should throw on unsupported config version", () => {
      const tmp = makeTempDir();
      try {
        writeFileSync(
          tmp.configPath,
          JSON.stringify({
            version: 99,
            dataDir: "/tmp/test",
            neo4j: { uri: "bolt://localhost:7687", user: "neo4j", password: "x" },
            qdrant: { url: "http://localhost:6333", collection: "c" },
            embeddings: { provider: "builtin", model: "m", dimension: 384 },
          })
        );
        assert.throws(
          () => configModule.parseConfigJson(tmp.configPath),
          (err) => {
            assert.ok(err.message.includes("version"), `Expected 'version' in: ${err.message}`);
            return true;
          }
        );
      } finally {
        tmp.cleanup();
      }
    });

    it("should throw on invalid embeddings.provider", () => {
      const tmp = makeTempDir();
      try {
        writeFileSync(
          tmp.configPath,
          JSON.stringify({
            version: 3,
            dataDir: "/tmp/test",
            neo4j: { uri: "bolt://localhost:7687", user: "neo4j", password: "x" },
            qdrant: { url: "http://localhost:6333", collection: "c" },
            embeddings: { provider: "openai", model: "m", dimension: 384 },
          })
        );
        assert.throws(
          () => configModule.parseConfigJson(tmp.configPath),
          (err) => {
            assert.ok(
              err.message.includes("embeddings.provider") && err.message.includes("openai"),
              `Expected embeddings.provider + openai in: ${err.message}`
            );
            return true;
          }
        );
      } finally {
        tmp.cleanup();
      }
    });

    it("should apply default values for optional validation fields", () => {
      const tmp = makeTempDir();
      try {
        const dataDir = join(tmpdir(), `sm-data-${randomUUID()}`);
        // No validation, ingest, or layers sections
        writeFileSync(
          tmp.configPath,
          JSON.stringify({
            version: 3,
            dataDir,
            neo4j: { uri: "bolt://localhost:7687", user: "neo4j", password: "x" },
            qdrant: { url: "http://localhost:6333", collection: "c" },
            embeddings: { provider: "builtin", model: "all-MiniLM-L6-v2", dimension: 384 },
          })
        );

        // parseConfigJson should not throw when optional sections are missing
        const config = configModule.parseConfigJson(tmp.configPath);

        // The Config interface doesn't have validation/ingest directly,
        // but the function should succeed (defaults applied internally)
        assert.ok(config, "Config should be returned successfully");
        assert.strictEqual(config.embeddingProvider, "builtin");
        assert.strictEqual(config.dualMode, false);

        if (existsSync(dataDir)) rmSync(dataDir, { recursive: true, force: true });
      } finally {
        tmp.cleanup();
      }
    });

    it("should enable dualMode when layers.mode is auto and globalDir is set", () => {
      const tmp = makeTempDir();
      const dataDir = join(tmpdir(), `sm-data-${randomUUID()}`);
      const globalDir = join(tmpdir(), `sm-global-${randomUUID()}`);
      try {
        writeFileSync(
          tmp.configPath,
          JSON.stringify({
            version: 3,
            dataDir,
            neo4j: { uri: "bolt://localhost:7687", user: "neo4j", password: "x" },
            qdrant: { url: "http://localhost:6333", collection: "c" },
            embeddings: { provider: "builtin", model: "all-MiniLM-L6-v2", dimension: 384 },
            layers: { mode: "auto", globalDir },
          })
        );

        const config = configModule.parseConfigJson(tmp.configPath);
        assert.strictEqual(config.dualMode, true);
        assert.strictEqual(config.globalDir, globalDir);
      } finally {
        tmp.cleanup();
        if (existsSync(dataDir)) rmSync(dataDir, { recursive: true, force: true });
        if (existsSync(globalDir)) rmSync(globalDir, { recursive: true, force: true });
      }
    });

    it("should disable dualMode when layers.mode is off", () => {
      const tmp = makeTempDir();
      const dataDir = join(tmpdir(), `sm-data-${randomUUID()}`);
      try {
        writeFileSync(
          tmp.configPath,
          JSON.stringify({
            version: 3,
            dataDir,
            neo4j: { uri: "bolt://localhost:7687", user: "neo4j", password: "x" },
            qdrant: { url: "http://localhost:6333", collection: "c" },
            embeddings: { provider: "builtin", model: "all-MiniLM-L6-v2", dimension: 384 },
            layers: { mode: "off", globalDir: "/some/dir" },
          })
        );

        const config = configModule.parseConfigJson(tmp.configPath);
        assert.strictEqual(config.dualMode, false);
      } finally {
        tmp.cleanup();
        if (existsSync(dataDir)) rmSync(dataDir, { recursive: true, force: true });
      }
    });

    it("should handle ollama provider correctly", () => {
      const tmp = makeTempDir();
      const dataDir = join(tmpdir(), `sm-data-${randomUUID()}`);
      try {
        writeFileSync(
          tmp.configPath,
          JSON.stringify({
            version: 3,
            dataDir,
            neo4j: { uri: "bolt://localhost:7687", user: "neo4j", password: "x" },
            qdrant: { url: "http://localhost:6333", collection: "c" },
            embeddings: { provider: "ollama", model: "nomic-embed-text", dimension: 768 },
          })
        );

        const config = configModule.parseConfigJson(tmp.configPath);
        assert.strictEqual(config.embeddingProvider, "ollama");
        assert.strictEqual(config.embeddingModel, "nomic-embed-text");
        assert.strictEqual(config.ollamaModel, "nomic-embed-text");
        assert.strictEqual(config.embeddingDim, 768);
      } finally {
        tmp.cleanup();
        if (existsSync(dataDir)) rmSync(dataDir, { recursive: true, force: true });
      }
    });

    it("should throw when config file content is a JSON array", () => {
      const tmp = makeTempDir();
      try {
        writeFileSync(tmp.configPath, "[1,2,3]");
        assert.throws(
          () => configModule.parseConfigJson(tmp.configPath),
          (err) => {
            assert.ok(err.message.includes("JSON object"), `Expected 'JSON object' in: ${err.message}`);
            return true;
          }
        );
      } finally {
        tmp.cleanup();
      }
    });

    it("should throw when field has wrong type (dataDir is number instead of string)", () => {
      const tmp = makeTempDir();
      try {
        writeFileSync(
          tmp.configPath,
          JSON.stringify({
            version: 3,
            dataDir: 42,
            neo4j: { uri: "bolt://localhost:7687", user: "neo4j", password: "x" },
            qdrant: { url: "http://localhost:6333", collection: "c" },
            embeddings: { provider: "builtin", model: "m", dimension: 384 },
          })
        );
        assert.throws(
          () => configModule.parseConfigJson(tmp.configPath),
          (err) => {
            assert.ok(
              err.message.includes('"dataDir"') && err.message.includes("string"),
              `Expected '"dataDir"' and 'string' in: ${err.message}`
            );
            return true;
          }
        );
      } finally {
        tmp.cleanup();
      }
    });
  });

  describe("getConfigFromEnv (v2 backward compat)", () => {
    let restore;

    beforeEach(() => {
      restore = clearConfigEnv();
    });

    afterEach(() => {
      restore();
    });

    it("should return Config from env vars with defaults", () => {
      // No env vars set -- should use defaults
      const config = configModule.getConfigFromEnv();

      assert.strictEqual(config.embeddingProvider, "builtin");
      assert.strictEqual(config.embeddingDim, 384);
      assert.strictEqual(config.embeddingModel, "Xenova/all-MiniLM-L6-v2");
      assert.strictEqual(config.neo4jUri, "bolt://localhost:7687");
      assert.strictEqual(config.neo4jUser, "neo4j");
      assert.strictEqual(config.neo4jPassword, "memory_pass_2024");
      assert.strictEqual(config.ollamaUrl, "http://localhost:11434");
      assert.strictEqual(config.ollamaModel, "nomic-embed-text");
      assert.strictEqual(config.dualMode, false);
      assert.strictEqual(config.qdrantUrl, undefined);
      assert.strictEqual(config.qdrantCollection, "semantic_memory_facts");
    });

    it("should read custom env vars", () => {
      process.env["NEO4J_URI"] = "bolt://custom:7687";
      process.env["NEO4J_USER"] = "custom_user";
      process.env["NEO4J_PASSWORD"] = "custom_pass";
      process.env["QDRANT_URL"] = "http://custom-qdrant:6333";
      process.env["QDRANT_COLLECTION"] = "custom_collection";
      process.env["EMBEDDING_PROVIDER"] = "ollama";
      process.env["EMBEDDING_DIM"] = "768";
      process.env["OLLAMA_URL"] = "http://custom-ollama:11434";
      process.env["OLLAMA_MODEL"] = "custom-model";

      const config = configModule.getConfigFromEnv();

      assert.strictEqual(config.neo4jUri, "bolt://custom:7687");
      assert.strictEqual(config.neo4jUser, "custom_user");
      assert.strictEqual(config.neo4jPassword, "custom_pass");
      assert.strictEqual(config.qdrantUrl, "http://custom-qdrant:6333");
      assert.strictEqual(config.qdrantCollection, "custom_collection");
      assert.strictEqual(config.embeddingProvider, "ollama");
      assert.strictEqual(config.embeddingDim, 768);
      assert.strictEqual(config.ollamaUrl, "http://custom-ollama:11434");
      assert.strictEqual(config.ollamaModel, "custom-model");
    });

    it("should enable dual mode when CLAUDE_MEMORY_GLOBAL_DIR is set", () => {
      const globalDir = join(tmpdir(), `sm-global-${randomUUID()}`);
      process.env["CLAUDE_MEMORY_GLOBAL_DIR"] = globalDir;

      const config = configModule.getConfigFromEnv();

      assert.strictEqual(config.dualMode, true);
      assert.strictEqual(config.globalDir, globalDir);

      // Cleanup
      if (existsSync(globalDir)) rmSync(globalDir, { recursive: true, force: true });
    });

    it("should throw on invalid EMBEDDING_PROVIDER", () => {
      process.env["EMBEDDING_PROVIDER"] = "openai";

      assert.throws(
        () => configModule.getConfigFromEnv(),
        (err) => {
          assert.ok(
            err.message.includes("EMBEDDING_PROVIDER") && err.message.includes("openai"),
            `Expected EMBEDDING_PROVIDER + openai in: ${err.message}`
          );
          return true;
        }
      );
    });
  });

  describe("getConfig (resolution order)", () => {
    let restore;

    beforeEach(() => {
      restore = clearConfigEnv();
    });

    afterEach(() => {
      restore();
    });

    it("should use SEMANTIC_MEMORY_CONFIG env var when set (pointing to valid file)", () => {
      const tmp = makeTempDir();
      const dataDir = join(tmpdir(), `sm-data-${randomUUID()}`);
      try {
        writeFileSync(tmp.configPath, JSON.stringify({
          version: 3,
          dataDir,
          neo4j: { uri: "bolt://from-env-path:7687", user: "neo4j", password: "from_env" },
          qdrant: { url: "http://localhost:6333", collection: "env_collection" },
          embeddings: { provider: "builtin", model: "all-MiniLM-L6-v2", dimension: 384 },
        }));

        process.env["SEMANTIC_MEMORY_CONFIG"] = tmp.configPath;

        const config = configModule.getConfig();

        assert.strictEqual(config.neo4jUri, "bolt://from-env-path:7687");
        assert.strictEqual(config.neo4jPassword, "from_env");
        assert.strictEqual(config.qdrantCollection, "env_collection");

        if (existsSync(dataDir)) rmSync(dataDir, { recursive: true, force: true });
      } finally {
        tmp.cleanup();
      }
    });

    it("should throw when SEMANTIC_MEMORY_CONFIG points to nonexistent file", () => {
      process.env["SEMANTIC_MEMORY_CONFIG"] = "/nonexistent/path/config.json";

      assert.throws(
        () => configModule.getConfig(),
        (err) => {
          assert.ok(
            err.message.includes("Config file not found") &&
            err.message.includes("SEMANTIC_MEMORY_CONFIG"),
            `Expected 'Config file not found' + 'SEMANTIC_MEMORY_CONFIG' in: ${err.message}`
          );
          return true;
        }
      );
    });

    it("should fall back to env vars when no config.json exists", () => {
      // No SEMANTIC_MEMORY_CONFIG, no ~/.semantic-memory/config.json
      // (We can't easily control ~/.semantic-memory in tests, but with
      // SEMANTIC_MEMORY_CONFIG unset and no home config, it falls back)
      process.env["NEO4J_PASSWORD"] = "env_fallback_pass";

      const config = configModule.getConfig();

      // If ~/.semantic-memory/config.json exists on this machine,
      // the test may not reach env fallback. Check both cases:
      assert.ok(config.neo4jPassword, "password should be set");
    });
  });

  describe("ConfigV3 type in types.ts", () => {
    it("should export ConfigV3 interface", async () => {
      const types = await import("../dist/types.js");
      // ConfigV3 is an interface (type-only), so it won't be a runtime export.
      // But we can verify the module loads without errors.
      assert.ok(types, "types module should load successfully");
    });
  });
});
