import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { getConfig } from "./config.js";
import { createBackend } from "./backend-factory.js";
import { createDualBackend } from "./dual.js";
import { initEmbeddings } from "./embeddings.js";
import type { StorageBackend } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(
  readFileSync(join(__dirname, "..", "package.json"), "utf-8"),
) as { version: string };

export const VERSION = pkg.version;

export function printHelp(): void {
  console.error(`semantic-memory-mcp — Semantic memory MCP server for Claude Code

Usage:
  semantic-memory-mcp                        Start MCP server (stdio transport)
  semantic-memory-mcp serve                  Start MCP server (stdio transport)
  semantic-memory-mcp init                   Add to ~/.claude.json and activate
  semantic-memory-mcp start                  Start Docker containers
  semantic-memory-mcp stop                   Stop Docker containers
  semantic-memory-mcp status                 Health dashboard
  semantic-memory-mcp promote                Promote project facts to global memory
  semantic-memory-mcp delete <id1> [id2 ..]  Delete facts by ID
  semantic-memory-mcp delete --search "q"    Search and interactively delete facts
  semantic-memory-mcp migrate-qdrant [flags] Migrate facts from Neo4j to Qdrant
    --no-reconcile                           Skip orphan cleanup
    --recreate                               Drop and recreate Qdrant collection
    --re-embed                               Re-generate embeddings with wrong dimensions
  semantic-memory-mcp ingest                 Ingest documentation (v3, not yet implemented)
  semantic-memory-mcp sweep                  One-shot stale fact review (Sonnet)
  semantic-memory-mcp sweep --subject X      Scope sweep to entity
  semantic-memory-mcp sweep --source X       Scope sweep to source
  semantic-memory-mcp sweep --batch-size N   Override batch size
  semantic-memory-mcp export                 Export facts to JSONL (v3, not yet implemented)
  semantic-memory-mcp import <file>          Import facts from JSONL (v3, not yet implemented)
  semantic-memory-mcp validate               Manual full sweep (v3, not yet implemented)
  semantic-memory-mcp version                Show version
  semantic-memory-mcp help                   Show this help

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
}

export async function runCli(args: string[]): Promise<void> {
  const command = args[0] ?? "serve";

  switch (command) {
    case "serve": {
      const { runServe } = await import("./cli/serve.js");
      await runServe(VERSION);
      break;
    }

    case "init": {
      const { runInit } = await import("./init.js");
      await runInit();
      process.exit(0);
    }

    case "start": {
      const { runStart } = await import("./cli/start.js");
      await runStart();
      process.exit(0);
    }

    case "stop": {
      const { runStop } = await import("./cli/stop.js");
      await runStop();
      process.exit(0);
    }

    case "status": {
      const { runStatus } = await import("./cli/status.js");
      await runStatus();
      process.exit(0);
    }

    case "promote": {
      const config = getConfig();
      if (!config.dualMode) {
        console.error(
          "Promote is only available in dual mode.\n" +
            "Set CLAUDE_MEMORY_GLOBAL_DIR to enable per-project memory,\n" +
            "or run 'npx semantic-memory-mcp init' and enable per-project memory.",
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

    case "delete": {
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
      await runDelete(backend, embed, args.slice(1));

      await backend.close();
      process.exit(0);
    }

    case "migrate-qdrant": {
      const flags = {
        reconcile: !args.includes("--no-reconcile"),
        recreate: args.includes("--recreate"),
        reEmbed: args.includes("--re-embed"),
      };
      const { runMigrateQdrant } = await import("./migrate-qdrant.js");
      await runMigrateQdrant(flags);
      process.exit(0);
    }

    case "version":
    case "--version":
    case "-v": {
      console.error(`semantic-memory-mcp ${VERSION}`);
      process.exit(0);
    }

    case "help":
    case "--help":
    case "-h": {
      printHelp();
      process.exit(0);
    }

    // v3 placeholders
    case "ingest": {
      const { runIngest } = await import("./cli/ingest.js");
      await runIngest(args.slice(1));
      process.exit(0);
    }

    case "sweep": {
      const { runSweep } = await import("./cli/sweep.js");
      await runSweep(args.slice(1));
      process.exit(0);
    }

    case "export": {
      const { runExport } = await import("./cli/export.js");
      await runExport(args.slice(1));
      process.exit(0);
    }

    case "import": {
      const { runImport } = await import("./cli/import.js");
      await runImport(args.slice(1));
      process.exit(0);
    }

    case "validate": {
      console.error("Not implemented yet (v3 Step 7)");
      process.exit(0);
    }

    default: {
      console.error(`Unknown command: ${command}`);
      console.error('Run "semantic-memory-mcp help" for usage information.');
      process.exit(1);
    }
  }
}
