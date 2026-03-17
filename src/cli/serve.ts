import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { getConfig } from "../config.js";
import { initEmbeddings } from "../embeddings.js";
import { createBackend } from "../backend-factory.js";
import { createDualBackend } from "../dual.js";
import { registerStoreTool } from "../tools/store.js";
import { registerSearchTool } from "../tools/search.js";
import { registerGraphTool } from "../tools/graph.js";
import { registerListTool } from "../tools/list.js";
import { registerDeleteTool } from "../tools/delete.js";
import { registerValidateTool } from "../tools/validate.js";
import { registerIngestTool } from "../tools/ingest.js";
import { registerIngestUrlTool } from "../tools/ingest-url.js";
import type { StorageBackend } from "../types.js";
import { maybeSweepOnStart } from "../sweep.js";

export async function runServe(version: string): Promise<void> {
  const server = new McpServer({
    name: "semantic-memory",
    version,
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
  registerValidateTool(server, backend, config);
  registerIngestTool(server, backend, embed, config);
  registerIngestUrlTool(server, backend, embed, config);

  // Fire-and-forget sweep on start (does not block serve)
  void maybeSweepOnStart(config, backend);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Graceful shutdown
  const shutdown = async () => {
    await backend.close();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}
