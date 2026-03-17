#!/usr/bin/env node

// stdout protection — MUST be before any imports that might log to stdout.
// MCP stdio transport uses stdout for JSON-RPC; any pollution breaks the protocol.
const _origLog = console.log;
console.log = (...args: unknown[]) => console.error('[log]', ...args);

import { runCli } from "./cli.js";

<<<<<<< HEAD
await runCli(process.argv.slice(2));
=======
// CLI subcommands
const command = process.argv[2];

if (command === "init") {
  const { runInit } = await import("./init.js");
  await runInit();
  process.exit(0);
}

if (command === "promote") {
  const config = getConfig();
  if (!config.dualMode) {
    console.error(
      "Promote is only available in dual mode.\n" +
      "Set CLAUDE_MEMORY_GLOBAL_DIR to enable per-project memory,\n" +
      "or run 'npx semantic-memory-mcp init' and enable per-project memory."
    );
    process.exit(1);
  }

  const projectBackend = await createBackend(config, "project");
  const globalBackend = await createBackend(config, "global");
  const embed = await initEmbeddings();

  const { runPromote } = await import("./promote.js");
  await runPromote(projectBackend, globalBackend, embed);

  await Promise.all([projectBackend.close(), globalBackend.close()]);
  process.exit(0);
}

if (command === "delete") {
  const config = getConfig();
  let backend: StorageBackend;
  if (config.dualMode) {
    const projectBackend = await createBackend(config, "project");
    const globalBackend = await createBackend(config, "global");
    backend = createDualBackend(projectBackend, globalBackend);
  } else {
    backend = await createBackend(config, "project");
  }

  const embed = await initEmbeddings();
  const { runDelete } = await import("./delete-cmd.js");
  await runDelete(backend, embed, process.argv.slice(3));

  await backend.close();
  process.exit(0);
}

if (command === "migrate-qdrant") {
  const flags = {
    reconcile: !process.argv.includes("--no-reconcile"),
    recreate: process.argv.includes("--recreate"),
    reEmbed: process.argv.includes("--re-embed"),
  };
  const { runMigrateQdrant } = await import("./migrate-qdrant.js");
  await runMigrateQdrant(flags);
  process.exit(0);
}

if (command === "export") {
  const config = getConfig();
  if (!config.qdrantUrl) {
    console.error("Export requires Qdrant. Set QDRANT_URL environment variable.");
    process.exit(1);
  }

  const { initQdrant } = await import("./qdrant.js");
  const qdrant = initQdrant(config.qdrantUrl, config.qdrantCollection, config.qdrantApiKey);
  await qdrant.ensureCollection(config.embeddingDim);

  const args = process.argv.slice(3);
  let source: string | undefined;
  let output: string | undefined;
  let includeOutdated = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--source" && args[i + 1]) {
      source = args[++i];
    } else if (args[i] === "--output" && args[i + 1]) {
      output = args[++i];
    } else if (args[i] === "--include-outdated") {
      includeOutdated = true;
    }
  }

  const { runExport } = await import("./cli/export.js");
  await runExport(qdrant, { source, output, includeOutdated });
  process.exit(0);
}

if (command === "import") {
  const config = getConfig();
  const args = process.argv.slice(3);

  // First non-flag argument is the file path
  let filePath: string | undefined;
  let sourceOverride: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--source-override" && args[i + 1]) {
      sourceOverride = args[++i];
    } else if (!args[i]!.startsWith("--")) {
      filePath = args[i];
    }
  }

  if (!filePath) {
    console.error("Usage: semantic-memory-mcp import <file.jsonl> [--source-override <tag>]");
    process.exit(1);
  }

  let backend: StorageBackend;
  if (config.dualMode) {
    const projectBackend = await createBackend(config, "project");
    const globalBackend = await createBackend(config, "global");
    backend = createDualBackend(projectBackend, globalBackend);
  } else {
    backend = await createBackend(config, "project");
  }

  const embed = await initEmbeddings();
  const { runImport } = await import("./cli/import.js");
  await runImport(filePath, backend, embed, { sourceOverride });

  await backend.close();
  process.exit(0);
}

if (command === "version" || command === "--version" || command === "-v") {
  console.log(`semantic-memory-mcp ${VERSION}`);
  process.exit(0);
}

if (command === "help" || command === "--help" || command === "-h") {
  console.log(`semantic-memory-mcp — Semantic memory MCP server for Claude Code

Usage:
  semantic-memory-mcp                        Start MCP server (stdio transport)
  semantic-memory-mcp init                   Add to ~/.claude.json and activate
  semantic-memory-mcp promote                Promote project facts to global memory
  semantic-memory-mcp delete <id1> [id2 ..]  Delete facts by ID
  semantic-memory-mcp delete --search "q"    Search and interactively delete facts
  semantic-memory-mcp export [options]       Export facts to JSONL
    --source <pattern>                       Filter by source (supports prefix: "lib:*")
    --output <file>                          Output file (default: stdout)
    --include-outdated                       Include superseded facts
  semantic-memory-mcp import <file> [opts]   Import facts from JSONL
    --source-override <tag>                  Override source for all imported facts
  semantic-memory-mcp migrate-qdrant [flags] Migrate facts from Neo4j to Qdrant
    --no-reconcile                           Skip orphan cleanup
    --recreate                               Drop and recreate Qdrant collection
    --re-embed                               Re-generate embeddings with wrong dimensions
  semantic-memory-mcp version                Show version

Environment variables:
  CLAUDE_MEMORY_DIR            Data directory (default: ~/.cache/claude-memory)
  CLAUDE_MEMORY_MODEL_CACHE    Embedding model cache directory

  EMBEDDING_PROVIDER           "builtin" (default) or "ollama"
  EMBEDDING_DIM                Embedding dimension (default: 384 for builtin, 768 for ollama)

  OLLAMA_URL                   Ollama API endpoint (default: http://localhost:11434)
  OLLAMA_MODEL                 Ollama embedding model (default: nomic-embed-text)

  NEO4J_URI                    Neo4j bolt URI (default: bolt://localhost:7687)
  NEO4J_USER                   Neo4j username (default: neo4j)
  NEO4J_PASSWORD               Neo4j password (default: memory_pass_2024)

  MEMORY_TRIGGERS_STORE        Extra trigger words for memory_store (comma-separated)
  MEMORY_TRIGGERS_SEARCH       Extra trigger words for memory_search (comma-separated)
  MEMORY_TRIGGERS_GRAPH        Extra trigger words for memory_graph (comma-separated)
  MEMORY_TRIGGERS_LIST         Extra trigger words for memory_list_entities (comma-separated)
  MEMORY_TRIGGERS_DELETE       Extra trigger words for memory_delete (comma-separated)

  CLAUDE_MEMORY_GLOBAL_DIR     Global memory directory (enables dual mode)

  QDRANT_URL                   Qdrant REST endpoint (enables Qdrant vector search)
  QDRANT_API_KEY               Qdrant API key (optional, for Qdrant Cloud)
  QDRANT_COLLECTION            Qdrant collection name (default: semantic_memory_facts)
`);
  process.exit(0);
}

// MCP Server mode
const server = new McpServer({
  name: "semantic-memory",
  version: VERSION,
});

const config = getConfig();

let backend: StorageBackend;
if (config.dualMode) {
  console.error("[claude-memory] Dual mode: project + global layers");
  const projectBackend = await createBackend(config, "project");
  const globalBackend = await createBackend(config, "global");
  backend = createDualBackend(projectBackend, globalBackend);
} else {
  backend = await createBackend(config, "project");
}

const embed = await initEmbeddings();

registerStoreTool(server, backend, embed, config);
registerSearchTool(server, backend, embed, config);
registerGraphTool(server, backend, config);
registerListTool(server, backend, config);
registerDeleteTool(server, backend, config);

const transport = new StdioServerTransport();
await server.connect(transport);

// Graceful shutdown
const shutdown = async () => {
  await backend.close();
  process.exit(0);
};

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
>>>>>>> worktree-agent-a0d1775b
