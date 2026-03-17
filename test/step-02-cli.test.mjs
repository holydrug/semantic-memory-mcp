import { describe, it } from "node:test";
import assert from "node:assert";
import { execSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const BIN = join(ROOT, "dist", "index.js");

/**
 * Run the CLI binary and capture stdout + stderr separately.
 * Returns { stdout, stderr, exitCode }.
 */
function runCli(args = "", env = {}) {
  try {
    const stdout = execSync(`node "${BIN}" ${args}`, {
      encoding: "utf-8",
      cwd: ROOT,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10_000,
    });
    return { stdout, stderr: "", exitCode: 0 };
  } catch (err) {
    return {
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? "",
      exitCode: err.status ?? 1,
    };
  }
}

/**
 * Run the CLI and capture stderr (where our output goes due to stdout protection).
 */
function runCliStderr(args = "", env = {}) {
  try {
    execSync(`node "${BIN}" ${args}`, {
      encoding: "utf-8",
      cwd: ROOT,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10_000,
    });
    // execSync throws on non-zero exit, but for exit(0) it returns stdout
    // We need stderr — use a different approach
  } catch (err) {
    return {
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? "",
      exitCode: err.status ?? 1,
    };
  }
  // If we get here, exit code was 0 but we can't capture stderr with execSync easily.
  // Use spawnSync instead.
  return null;
}

// Use spawnSync for proper stdout/stderr capture
import { spawnSync } from "node:child_process";

function run(args = "", env = {}) {
  const result = spawnSync("node", [BIN, ...args.split(/\s+/).filter(Boolean)], {
    encoding: "utf-8",
    cwd: ROOT,
    env: { ...process.env, ...env },
    timeout: 10_000,
  });
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    exitCode: result.status ?? 1,
  };
}

describe("Step 02 — CLI Framework", () => {
  describe("stdout protection", () => {
    it("console.log output goes to stderr, not stdout", () => {
      // The version command uses console.error, so stdout should be empty.
      // Any console.log calls are redirected to stderr with [log] prefix.
      const result = run("version");
      assert.strictEqual(result.stdout, "", "stdout must be clean (no console.log leaks)");
      assert.ok(
        result.stderr.includes("semantic-memory-mcp"),
        "version info should appear on stderr",
      );
    });
  });

  describe("help command", () => {
    it("prints usage information", () => {
      const result = run("help");
      assert.strictEqual(result.exitCode, 0);
      assert.ok(result.stderr.includes("semantic-memory-mcp"), "should mention the tool name");
      assert.ok(result.stderr.includes("serve"), "should list serve command");
      assert.ok(result.stderr.includes("init"), "should list init command");
      assert.ok(result.stderr.includes("start"), "should list start command");
      assert.ok(result.stderr.includes("stop"), "should list stop command");
      assert.ok(result.stderr.includes("status"), "should list status command");
      assert.ok(result.stderr.includes("ingest"), "should list ingest placeholder");
      assert.ok(result.stderr.includes("sweep"), "should list sweep placeholder");
      assert.ok(result.stderr.includes("export"), "should list export placeholder");
      assert.ok(result.stderr.includes("import"), "should list import placeholder");
      assert.ok(result.stderr.includes("validate"), "should list validate placeholder");
    });

    it("--help alias works", () => {
      const result = run("--help");
      assert.strictEqual(result.exitCode, 0);
      assert.ok(result.stderr.includes("semantic-memory-mcp"));
    });

    it("-h alias works", () => {
      const result = run("-h");
      assert.strictEqual(result.exitCode, 0);
      assert.ok(result.stderr.includes("semantic-memory-mcp"));
    });
  });

  describe("version command", () => {
    it("prints version string", () => {
      const result = run("version");
      assert.strictEqual(result.exitCode, 0);
      assert.match(result.stderr, /semantic-memory-mcp \d+\.\d+\.\d+/);
    });

    it("--version alias works", () => {
      const result = run("--version");
      assert.strictEqual(result.exitCode, 0);
      assert.match(result.stderr, /semantic-memory-mcp \d+\.\d+\.\d+/);
    });

    it("-v alias works", () => {
      const result = run("-v");
      assert.strictEqual(result.exitCode, 0);
      assert.match(result.stderr, /semantic-memory-mcp \d+\.\d+\.\d+/);
    });
  });

  describe("unknown command", () => {
    it('prints "Unknown command" and exits with code 1', () => {
      const result = run("nonexistent-command");
      assert.strictEqual(result.exitCode, 1);
      assert.ok(
        result.stderr.includes("Unknown command"),
        `stderr should contain "Unknown command", got: ${result.stderr}`,
      );
    });
  });

  describe("placeholder commands", () => {
    for (const [cmd, step] of [
      ["ingest", "Step 13"],
      ["export", "Step 14"],
      ["import", "Step 14"],
      ["validate", "Step 7"],
    ]) {
      it(`${cmd} → "Not implemented yet (v3 ${step})"`, () => {
        const result = run(cmd);
        assert.strictEqual(result.exitCode, 0, `${cmd} should exit 0`);
        assert.ok(
          result.stderr.includes("Not implemented yet"),
          `${cmd} should print "Not implemented yet"`,
        );
        assert.ok(
          result.stderr.includes(step),
          `${cmd} should reference ${step}`,
        );
      });
    }
  });

  describe("status command", () => {
    it("runs without crashing (may report not configured)", () => {
      // Without a real config, status should either show info or say not configured
      const result = run("status");
      assert.strictEqual(result.exitCode, 0);
      assert.ok(
        result.stderr.includes("semantic-memory") ||
          result.stderr.includes("not configured"),
        "should print status or 'not configured'",
      );
    });
  });

  describe("default command (no args)", () => {
    it("defaults to serve (will fail without backends, but routes correctly)", () => {
      // Running without args should attempt to start the MCP server.
      // It will fail because Neo4j/Qdrant aren't available, but we verify
      // it routes to serve by checking stderr output.
      const result = run("", {
        // Ensure no real connection to prevent hanging
        NEO4J_URI: "bolt://localhost:99999",
      });
      // It will exit non-zero because backends are unavailable
      // The key assertion: it attempts to start (doesn't print "Unknown command")
      assert.ok(
        !result.stderr.includes("Unknown command"),
        "should not treat empty args as unknown command",
      );
    });
  });
});
