# [3.0.0](https://github.com/holydrug/semantic-memory-mcp/compare/v2.1.3...v3.0.0) (2026-03-17)


* feat!: V3 release ([5a9353d](https://github.com/holydrug/semantic-memory-mcp/commit/5a9353d83e4ff5f1c7e13da9660fd11f37827a97))


### Bug Fixes

* remove claudePath from SpawnClaudeOpts call in validate.ts ([89f1edf](https://github.com/holydrug/semantic-memory-mcp/commit/89f1edf9e62cd6350af214bec04a11a380c3a956))
* resolve final merge conflicts and update placeholder tests ([03d8d23](https://github.com/holydrug/semantic-memory-mcp/commit/03d8d230819a5206d27ca011c9c1cc90de10c326))
* resolve Wave 3 merge conflicts and type mismatches ([ff1bc6f](https://github.com/holydrug/semantic-memory-mcp/commit/ff1bc6f2dc0f32bfc766f8d39fffa8e29e401132))


### Features

* **v3:** step 01 — Config v3 with config.json support ([0856f5a](https://github.com/holydrug/semantic-memory-mcp/commit/0856f5ab4ef55a787f7dcea0cb137183029c7bce))
* **v3:** step 02+03 — CLI framework + Fact Schema v3 ([ceb5f3f](https://github.com/holydrug/semantic-memory-mcp/commit/ceb5f3fda9fdc2aeed5663ffefb93ee8e2341a89))
* **v3:** step 04 — Claude CLI subprocess wrapper ([dbd95fe](https://github.com/holydrug/semantic-memory-mcp/commit/dbd95fee7e495f71745bb992e5cc66be19ee2572))
* **v3:** step 05 — On-Store Validation ([65b668a](https://github.com/holydrug/semantic-memory-mcp/commit/65b668ae0bfe960048a742c8eec96d0220a2c6bf))
* **v3:** step 06 — On-Read Enrichment ([9d400d0](https://github.com/holydrug/semantic-memory-mcp/commit/9d400d03ba77b048debe53062a81c1d7f7d34163))
* **v3:** step 07 — Delete Cascade + Validate ([3e32d55](https://github.com/holydrug/semantic-memory-mcp/commit/3e32d55d6ae26f47f41b307dd67a122536ac3770))
* **v3:** step 08 — Sweep ([70c33f7](https://github.com/holydrug/semantic-memory-mcp/commit/70c33f701bb4548c1b7fb8f44f60b4014e900078))
* **v3:** step 09 — Hybrid Init ([48eaf5c](https://github.com/holydrug/semantic-memory-mcp/commit/48eaf5cb16f833b7748c65eec375ab96b8d0aec0))
* **v3:** step 10 — V2 Migration ([c447114](https://github.com/holydrug/semantic-memory-mcp/commit/c447114dbec5eae053b1eac9ca22b1a9b4733f8c))
* **v3:** step 11 — Auto-scan + Classifier ([6bf44f8](https://github.com/holydrug/semantic-memory-mcp/commit/6bf44f8f0c5c3e14a26a20d918840a7fda9b2b5f))
* **v3:** step 12 — Extraction + Orchestrator ([0b34827](https://github.com/holydrug/semantic-memory-mcp/commit/0b34827e7f9e1bd7a8c6d091ab7a23d95b3e7563))
* **v3:** step 13 — memory_ingest + memory_ingest_url + CLI ([cbe8e63](https://github.com/holydrug/semantic-memory-mcp/commit/cbe8e637fb7e4d09b7db9a51bc0812522fb8ec97))
* **v3:** step 14 — Export / Import ([cb76c07](https://github.com/holydrug/semantic-memory-mcp/commit/cb76c07a836e3ece547640fe6f80ee5399251192))


### BREAKING CHANGES

* Config resolution changed to ~/.semantic-memory/config.json with env var fallback.
StorageBackend interface extended with new required methods.
Fact schema has new fields: version, confidence, superseded_by, valid_from, valid_until.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>

## [2.1.3](https://github.com/holydrug/semantic-memory-mcp/compare/v2.1.2...v2.1.3) (2026-03-12)


### Bug Fixes

* robust re-embed with try/catch and shorter truncation limit ([1cea19b](https://github.com/holydrug/semantic-memory-mcp/commit/1cea19b65be5f6fa5faabb97060275af93a0a8ae))

## [2.1.2](https://github.com/holydrug/semantic-memory-mcp/compare/v2.1.1...v2.1.2) (2026-03-12)


### Bug Fixes

* truncate long facts before re-embedding in migration ([edac0f7](https://github.com/holydrug/semantic-memory-mcp/commit/edac0f76f38721259072d3a54e888c58b73336d3))

## [2.1.1](https://github.com/holydrug/semantic-memory-mcp/compare/v2.1.0...v2.1.1) (2026-03-12)


### Bug Fixes

* handle embedding dimension mismatch in migrate-qdrant ([d8219a3](https://github.com/holydrug/semantic-memory-mcp/commit/d8219a356a808a5763665cf102b1356211740a0f))

# [2.1.0](https://github.com/holydrug/semantic-memory-mcp/compare/v2.0.1...v2.1.0) (2026-03-12)


### Features

* add Qdrant vector search integration with dual-write architecture ([211dea5](https://github.com/holydrug/semantic-memory-mcp/commit/211dea54b6027ffbc925387d2de31a931ef3579a))

## [2.0.1](https://github.com/holydrug/semantic-memory-mcp/compare/v2.0.0...v2.0.1) (2026-03-12)


### Bug Fixes

* re-publish after npm unpublish (version 2.0.0 burned) ([6c327b6](https://github.com/holydrug/semantic-memory-mcp/commit/6c327b6af19dd53737eb0edc47e053dc1703084b))

# [2.0.0](https://github.com/holydrug/semantic-memory-mcp/compare/v1.2.2...v2.0.0) (2026-03-05)


### Features

* expose library exports for programmatic usage ([862064a](https://github.com/holydrug/semantic-memory-mcp/commit/862064ae166e7f6f62d65bcec7395c19a97ceda5))


### BREAKING CHANGES

* npm versions 1.2.0-1.2.2 are unavailable due to
registry cooldown. This release (1.3.0) is the first usable version
with exports.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>

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
