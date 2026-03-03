# semantic-memory-mcp

Persistent memory for [Claude Code](https://docs.anthropic.com/en/docs/claude-code). Knowledge graph with semantic search — works locally, no API keys needed.

## Quick start

```bash
npx semantic-memory-mcp@0.8.1 init
# Restart Claude Code — done!
```

The interactive wizard lets you choose between two modes:

| Mode | Storage | Embeddings | Dependencies |
|------|---------|------------|--------------|
| **Lightweight** | SQLite | Built-in (all-MiniLM-L6-v2, 384-dim) | None |
| **Full** | Neo4j | Ollama (nomic-embed-text, 768-dim+) | Docker |

**Full mode** generates a `docker-compose.yml` with Neo4j + Ollama, starts containers, pulls the embedding model — all from the wizard. On macOS it installs Ollama natively via Homebrew for Metal GPU acceleration.

## Dual mode: project + global memory

By default all facts go into one global database (`~/.cache/claude-memory/`). With **dual mode** you get two layers:

| Layer | Location | Contains |
|-------|----------|----------|
| **Project** | `./.semantic-memory/` | Bugs, workarounds, patterns for the current codebase |
| **Global** | `~/.cache/claude-memory/` | Tech stack, conventions, preferences — shared across projects |

Enable during init (on by default):

```bash
npx semantic-memory-mcp@0.8.1 init
# → Choose mode (Lightweight / Full)
# → "Share knowledge between projects?" → Y
```

### Auto-routing

Facts are routed to the correct layer at write time based on predicate:

| → Global | → Project (default) |
|----------|-----------|
| `uses`, `depends_on`, `deployed_on`, `written_in`, `has_version`, `runs_on`, `built_with`, `integrates_with`, `prefers`, `convention` | `blocked_by`, `workaround_for`, `todo`, `bug_in`, `fixed_by`, `needs_refactor`, `has_pattern`, `test_for`, `config_for` |

Unknown predicates default to project (promote manually).

Search and graph queries always hit both layers — no manual switching.

### Manual promote

Project-scoped facts can be promoted to global manually:

```bash
npx semantic-memory-mcp promote
```

Shows a numbered list, you pick which facts to promote (all / none / by number).

## Where to configure

There are three ways to connect the MCP server to Claude Code:

### Global (recommended for personal use)

Added automatically by `npx semantic-memory-mcp@0.8.1 init`. Config lives in `~/.claude.json`:

```json
{
  "mcpServers": {
    "semantic-memory": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "semantic-memory-mcp@0.8.1"]
    }
  }
}
```

### Per-project — shared with team

Create `.mcp.json` in the project root. Committed to the repo so the team shares the setup:

```json
{
  "mcpServers": {
    "semantic-memory": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "semantic-memory-mcp@0.8.1"],
      "env": {
        "CLAUDE_MEMORY_DIR": "./.semantic-memory"
      }
    }
  }
}
```

Add `.semantic-memory/` to `.gitignore`.

### Dual mode (auto-configured by init)

A single global entry in `~/.claude.json` handles all projects — no per-project config needed:

```json
{
  "mcpServers": {
    "semantic-memory": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "semantic-memory-mcp@0.8.1"],
      "env": {
        "CLAUDE_MEMORY_DIR": "./.semantic-memory",
        "CLAUDE_MEMORY_GLOBAL_DIR": "/home/user/.cache/claude-memory"
      }
    }
  }
}
```

## What it does

Claude Code gets 4 tools to remember things across sessions:

- **`memory_store`** — save a fact as a Subject → Predicate → Object triple
- **`memory_search`** — find facts by meaning (vector similarity)
- **`memory_graph`** — explore connections around an entity
- **`memory_list_entities`** — list everything stored

```
> "Remember that billing-service uses PostgreSQL 16"
  → Stored: [billing-service] -[uses]-> [PostgreSQL 16]

> "What do you know about billing?"
  → [0.856] [billing-service] -[uses]-> [PostgreSQL 16]
```

## Embedding models

| Model | Dim | Size | Best for |
|-------|-----|------|----------|
| `all-MiniLM-L6-v2` (builtin) | 384 | 80 MB | Zero-setup, good enough for most use cases |
| `nomic-embed-text` | 768 | 274 MB | Best balance of quality and speed (recommended for Full) |
| `mxbai-embed-large` | 1024 | 670 MB | Highest quality, complex semantic relationships |
| `all-minilm` | 384 | 45 MB | Smallest Ollama model, fast |

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `STORAGE_PROVIDER` | `sqlite` | `sqlite` or `neo4j` |
| `CLAUDE_MEMORY_DIR` | `~/.cache/claude-memory` | Data directory |
| `CLAUDE_MEMORY_DB` | `<data-dir>/memory.db` | SQLite database path |
| `CLAUDE_MEMORY_MODEL_CACHE` | `<data-dir>/models` | Embedding model cache |
| `EMBEDDING_PROVIDER` | `builtin` | `builtin` or `ollama` |
| `EMBEDDING_DIM` | `384` / `768` | Embedding dimension (auto-set by provider) |
| `OLLAMA_URL` | `http://localhost:11434` | Ollama API endpoint |
| `OLLAMA_MODEL` | `nomic-embed-text` | Ollama embedding model |
| `NEO4J_URI` | `bolt://localhost:7687` | Neo4j bolt URI |
| `NEO4J_USER` | `neo4j` | Neo4j username |
| `NEO4J_PASSWORD` | `memory_pass_2024` | Neo4j password |
| `CLAUDE_MEMORY_GLOBAL_DIR` | — | Global memory directory (enables dual mode) |
| `CLAUDE_MEMORY_GLOBAL_DB` | `<global-dir>/memory.db` | Global SQLite database path |
| `GLOBAL_STORAGE_PROVIDER` | `sqlite` | Global backend: `sqlite` or `neo4j` |
| `MEMORY_TRIGGERS_STORE` | — | Extra trigger words for `memory_store` (comma-separated) |
| `MEMORY_TRIGGERS_SEARCH` | — | Extra trigger words for `memory_search` (comma-separated) |
| `MEMORY_TRIGGERS_GRAPH` | — | Extra trigger words for `memory_graph` (comma-separated) |
| `MEMORY_TRIGGERS_LIST` | — | Extra trigger words for `memory_list_entities` (comma-separated) |

### Custom trigger words

Each tool has built-in trigger words (in Russian and English) that tell Claude when to use it. You can add your own triggers in any language via environment variables. Custom triggers are **appended** to the defaults, not replacing them.

Example — adding Chinese and Spanish triggers:

```json
{
  "mcpServers": {
    "semantic-memory": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "semantic-memory-mcp@0.8.1"],
      "env": {
        "MEMORY_TRIGGERS_STORE": "记住, recuerda, guardar",
        "MEMORY_TRIGGERS_SEARCH": "搜索记忆, buscar en memoria"
      }
    }
  }
}
```

You can also configure triggers interactively during `npx semantic-memory-mcp@0.8.1 init`.

## Updating

All commands and configs use a pinned version (`semantic-memory-mcp@0.8.1`). This README is automatically updated on each release, so copying any command from here always gives you the latest version.

## Requirements

- Node.js >= 18
- Docker (Full mode only)

## License

MIT
