/**
 * CLI command: `semantic-memory-mcp sweep`
 *
 * One-shot stale fact review via Claude Sonnet.
 */

import { getConfig } from "../config.js";
import { createBackend } from "../backend-factory.js";
import { createDualBackend } from "../dual.js";
import { sweepOnce } from "../sweep.js";
import type { StorageBackend } from "../types.js";

export async function runSweep(args: string[]): Promise<void> {
  const config = getConfig();

  // Parse CLI args
  let subject: string | undefined;
  let source: string | undefined;
  let batchSize: number | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--subject" && i + 1 < args.length) {
      subject = args[++i];
    } else if (arg === "--source" && i + 1 < args.length) {
      source = args[++i];
    } else if (arg === "--batch-size" && i + 1 < args.length) {
      const val = parseInt(args[++i] ?? "", 10);
      if (!isNaN(val) && val > 0) {
        batchSize = val;
      } else {
        console.error("Invalid --batch-size value, using default");
      }
    }
  }

  // Create backend
  let backend: StorageBackend;
  if (config.dualMode) {
    const projectBackend = await createBackend(config, "project");
    const globalBackend = await createBackend(config, "global");
    backend = createDualBackend(projectBackend, globalBackend);
  } else {
    backend = await createBackend(config, "project");
  }

  try {
    const result = await sweepOnce(config, backend, { subject, source, batchSize });

    if (result.reviewed === 0) {
      console.error("Sweep complete: no stale facts found");
    } else {
      console.error(`Sweep complete: reviewed ${result.reviewed} facts`);
      console.error(`  \u2705 ${result.confirmed} confirmed (still valid)`);
      console.error(`  \uD83D\uDD04 ${result.stale} stale (confidence reduced)`);
      console.error(`  \u2753 ${result.unknown} unknown (timer reset)`);
    }
  } finally {
    await backend.close();
  }
}
