import { createInterface } from "node:readline/promises";
import type { StorageBackend, EmbedFn } from "./types.js";
import { isDualBackend, parseFactId } from "./types.js";

async function deleteByIds(
  db: StorageBackend,
  ids: string[],
): Promise<{ deleted: number; failed: number }> {
  let deleted = 0;
  let failed = 0;
  const dual = isDualBackend(db);

  for (const id of ids) {
    try {
      const parsed = parseFactId(id, dual);
      if ("error" in parsed) {
        console.error(`  ${id}: error — ${parsed.error}`);
        failed++;
        continue;
      }

      const target = parsed.layer && dual
        ? db.getLayerBackend(parsed.layer)
        : db;
      const ok = await target.deleteFact(parsed.numericId);
      if (ok) {
        console.log(`  ${id}: deleted`);
        deleted++;
      } else {
        console.log(`  ${id}: not found`);
        failed++;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  ${id}: error — ${msg}`);
      failed++;
    }
  }

  return { deleted, failed };
}

/**
 * CLI command: delete facts by ID or via interactive search.
 *
 * Usage:
 *   semantic-memory-mcp delete <id1> [id2 ...]
 *   semantic-memory-mcp delete --search "query"
 */
export async function runDelete(
  db: StorageBackend,
  embed: EmbedFn,
  args: string[],
): Promise<void> {
  // Interactive search mode
  if (args[0] === "--search" || args[0] === "-s") {
    const query = args.slice(1).join(" ");
    if (!query) {
      console.error("Usage: semantic-memory-mcp delete --search \"query\"");
      process.exit(1);
    }

    const queryEmb = await embed(query);
    const results = await db.searchFacts(queryEmb, 20);

    if (results.length === 0) {
      console.log("No matching facts found.");
      return;
    }

    console.log(`\nSearch results for "${query}" (${results.length}):\n`);
    for (let i = 0; i < results.length; i++) {
      const r = results[i]!;
      console.log(
        `  ${i + 1}) (id: ${r.factId}) [${r.score.toFixed(3)}] [${r.subject}] -[${r.predicate}]-> [${r.object}]`
      );
      console.log(`     ${r.fact}`);
    }

    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const answer = (
        await rl.question("\nDelete: numbers (e.g. 1,3,5), A (all), or N (cancel): ")
      ).trim();

      if (answer.toLowerCase() === "n" || answer === "") {
        console.log("Cancelled.");
        return;
      }

      let selected: typeof results;
      if (answer.toLowerCase() === "a") {
        selected = results;
      } else {
        const indices = answer
          .split(",")
          .map((s) => parseInt(s.trim(), 10) - 1)
          .filter((n) => !isNaN(n) && n >= 0 && n < results.length);

        if (indices.length === 0) {
          console.log("No valid selections. Cancelled.");
          return;
        }
        selected = indices.map((i) => results[i]!);
      }

      const ids = selected.map((r) => r.factId);
      console.log(`\nDeleting ${ids.length} fact(s)...`);
      const { deleted, failed } = await deleteByIds(db, ids);
      console.log(`Done. ${deleted} deleted, ${failed} failed.`);
      if (deleted === 0 && failed > 0) process.exit(1);
    } finally {
      rl.close();
    }
    return;
  }

  // Direct delete mode: arguments are fact IDs
  if (args.length === 0) {
    console.error(
      "Usage:\n" +
      "  semantic-memory-mcp delete <id1> [id2 ...]\n" +
      '  semantic-memory-mcp delete --search "query"'
    );
    process.exit(1);
  }

  console.log(`Deleting ${args.length} fact(s)...`);
  const { deleted, failed } = await deleteByIds(db, args);
  console.log(`Done. ${deleted} deleted, ${failed} failed.`);
  if (deleted === 0 && failed > 0) process.exit(1);
}
