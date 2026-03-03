#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { getConfig } from "./config.js";
import { initDb, sqliteBackend } from "./db.js";
import { initNeo4j } from "./neo4j.js";
import { initEmbeddings } from "./embeddings.js";
import { createBackend } from "./backend-factory.js";
import { createDualBackend } from "./dual.js";
import { registerStoreTool } from "./tools/store.js";
import { registerSearchTool } from "./tools/search.js";
import { registerGraphTool } from "./tools/graph.js";
import { registerListTool } from "./tools/list.js";
import { registerDeleteTool } from "./tools/delete.js";
import type { StorageBackend } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf-8")) as { version: string };
const VERSION = pkg.version;

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

  const projectBackend = createBackend(config, "project");
  const globalBackend = createBackend(config, "global");
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
    const projectBackend = createBackend(config, "project");
    const globalBackend = createBackend(config, "global");
    backend = createDualBackend(projectBackend, globalBackend);
  } else if (config.storageProvider === "neo4j") {
    backend = initNeo4j();
  } else {
    backend = sqliteBackend(initDb());
  }

  const embed = await initEmbeddings();
  const { runDelete } = await import("./delete-cmd.js");
  await runDelete(backend, embed, process.argv.slice(3));

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
  semantic-memory-mcp version                Show version

Environment variables:
  STORAGE_PROVIDER             "sqlite" (default) or "neo4j"
  CLAUDE_MEMORY_DIR            Data directory (default: ~/.cache/claude-memory)
  CLAUDE_MEMORY_DB             SQLite database path
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
  CLAUDE_MEMORY_GLOBAL_DB      Global SQLite database path
  GLOBAL_STORAGE_PROVIDER      Global storage backend: "sqlite" (default) or "neo4j"
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
  const projectBackend = createBackend(config, "project");
  const globalBackend = createBackend(config, "global");
  backend = createDualBackend(projectBackend, globalBackend);
} else if (config.storageProvider === "neo4j") {
  console.error("[claude-memory] Using Neo4j storage backend");
  backend = initNeo4j();
} else {
  console.error("[claude-memory] Using SQLite storage backend");
  backend = sqliteBackend(initDb());
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
