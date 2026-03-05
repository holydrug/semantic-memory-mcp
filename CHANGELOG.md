## [1.2.2](https://github.com/holydrug/semantic-memory-mcp/compare/v1.2.1...v1.2.2) (2026-03-05)


### Bug Fixes

* resolve npm version conflict ([2d6fd3c](https://github.com/holydrug/semantic-memory-mcp/commit/2d6fd3c19f3042ed706b2b4f0ebbf59266698b4d))

## [1.2.1](https://github.com/holydrug/semantic-memory-mcp/compare/v1.2.0...v1.2.1) (2026-03-05)


### Bug Fixes

* re-publish after npm conflict ([6cb0480](https://github.com/holydrug/semantic-memory-mcp/commit/6cb04800af9950e8037f833a6b60f4cfd7e4b04e))

# [1.2.0](https://github.com/holydrug/semantic-memory-mcp/compare/v1.1.0...v1.2.0) (2026-03-05)


### Features

* add package exports for library usage ([1b841b1](https://github.com/holydrug/semantic-memory-mcp/commit/1b841b1108206a670b06cb8fc0dd2186d3cee825))

# [1.1.0](https://github.com/holydrug/semantic-memory-mcp/compare/v1.0.1...v1.1.0) (2026-03-04)


### Features

* automate dependency setup during init ([9414bde](https://github.com/holydrug/semantic-memory-mcp/commit/9414bde2d7e8878221e8e3e4369989a799975f79))

## [1.0.1](https://github.com/holydrug/semantic-memory-mcp/compare/v1.0.0...v1.0.1) (2026-03-03)


### Bug Fixes

* update CHANGELOG URLs to match renamed repository ([608515c](https://github.com/holydrug/semantic-memory-mcp/commit/608515c61c5fe3e001dcf19e2b46f6ef19b7f397))

# [1.0.0](https://github.com/holydrug/semantic-memory-mcp/compare/v0.9.0...v1.0.0) (2026-03-03)


* feat!: remove SQLite backend, Neo4j is now the only storage engine ([5733fef](https://github.com/holydrug/semantic-memory-mcp/commit/5733fef2d32fc59d46605b9b50d421aa048fed03))


### Bug Fixes

* update repository URL to match renamed GitHub repo ([8bc252d](https://github.com/holydrug/semantic-memory-mcp/commit/8bc252ddc0b321c7c589ace47f94ae86a2195e11))


### BREAKING CHANGES

* SQLite storage backend has been removed. Neo4j via Docker
is now required. The init wizard no longer offers Lightweight/Full mode
choice — it always sets up Neo4j with a choice of builtin or ollama
embeddings. Removed dependencies: better-sqlite3, sqlite-vec.

Removed env vars: STORAGE_PROVIDER, CLAUDE_MEMORY_DB,
CLAUDE_MEMORY_GLOBAL_DB, GLOBAL_STORAGE_PROVIDER.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>

# [0.9.0](https://github.com/holydrug/semantic-memory-mcp/compare/v0.8.1...v0.9.0) (2026-03-03)


### Features

* add memory_delete tool for deleting facts by ID ([926abe1](https://github.com/holydrug/semantic-memory-mcp/commit/926abe1664cac2947e8fcdc01c1d0edeb3dac9eb))

## [0.8.1](https://github.com/holydrug/semantic-memory-mcp/compare/v0.8.0...v0.8.1) (2026-03-03)


### Bug Fixes

* validate yes/no input in init wizard, re-prompt on typos ([02eaf37](https://github.com/holydrug/semantic-memory-mcp/commit/02eaf37eb581851e74e328bae1235fb7274f6c5a))

# [0.8.0](https://github.com/holydrug/semantic-memory-mcp/compare/v0.7.1...v0.8.0) (2026-03-02)


### Features

* auto-promote facts to correct layer based on predicate scope ([dbe2a39](https://github.com/holydrug/semantic-memory-mcp/commit/dbe2a393022f6768c8fd19f0e14d4e3261966ab0))

## [0.7.1](https://github.com/holydrug/semantic-memory-mcp/compare/v0.7.0...v0.7.1) (2026-03-02)


### Bug Fixes

* include dual mode vars in global MCP config when per-project enabled ([0d60a34](https://github.com/holydrug/semantic-memory-mcp/commit/0d60a34df6cca4edbaeffb52f8f954b6ad132ff8))

# [0.7.0](https://github.com/holydrug/semantic-memory-mcp/compare/v0.6.0...v0.7.0) (2026-03-02)


### Features

* per-project Neo4j layer isolation via project slug ([13be057](https://github.com/holydrug/semantic-memory-mcp/commit/13be0578da4d59dc3e95626538af946e55cd11b5))
