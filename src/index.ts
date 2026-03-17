#!/usr/bin/env node

// stdout protection — MUST be before any imports that might log to stdout.
// MCP stdio transport uses stdout for JSON-RPC; any pollution breaks the protocol.
const _origLog = console.log;
console.log = (...args: unknown[]) => console.error('[log]', ...args);

import { runCli } from "./cli.js";

await runCli(process.argv.slice(2));
