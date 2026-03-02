import { createInterface } from "node:readline/promises";
import type { StorageBackend, EmbedFn } from "./types.js";

/**
 * Interactive CLI to promote project facts to global backend.
 */
export async function runPromote(
  projectBackend: StorageBackend,
  globalBackend: StorageBackend,
  embed: EmbedFn,
): Promise<void> {
  if (!projectBackend.getCandidateFacts) {
    console.error("Project backend does not support candidate facts.");
    process.exit(1);
  }

  const candidates = await projectBackend.getCandidateFacts("project");

  if (candidates.length === 0) {
    console.log("No project facts to promote.");
    return;
  }

  console.log(`\nProject facts available for promotion (${candidates.length}):\n`);
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i]!;
    console.log(`  ${i + 1}) [${c.subject}] -[${c.predicate}]-> [${c.object}]`);
    console.log(`     ${c.content}`);
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question("\nPromote: Y (all), N (cancel), or numbers (e.g. 1,3,5): ")).trim();

    if (answer.toLowerCase() === "n" || answer === "") {
      console.log("Cancelled.");
      return;
    }

    let indices: number[];
    if (answer.toLowerCase() === "y") {
      indices = candidates.map((_, i) => i);
    } else {
      indices = answer.split(",")
        .map((s) => parseInt(s.trim(), 10) - 1)
        .filter((n) => !isNaN(n) && n >= 0 && n < candidates.length);

      if (indices.length === 0) {
        console.log("No valid selections. Cancelled.");
        return;
      }
    }

    let promoted = 0;
    for (const idx of indices) {
      const c = candidates[idx]!;

      // Re-embed for global backend
      const [subjectEmb, objectEmb, factEmb] = await Promise.all([
        embed(c.subject),
        embed(c.object),
        embed(c.content),
      ]);

      // Create entities and fact in global
      const subjectId = await globalBackend.findOrCreateEntity(c.subject, subjectEmb);
      const objectId = await globalBackend.findOrCreateEntity(c.object, objectEmb);
      await globalBackend.storeFact({
        subjectId,
        predicate: c.predicate,
        objectId,
        content: c.content,
        context: c.context,
        source: c.source,
        embedding: factEmb,
      });

      // Clear candidate flag in project
      if (projectBackend.updateFactScope) {
        await projectBackend.updateFactScope(c.factId, null);
      }

      promoted++;
    }

    console.log(`\nPromoted ${promoted} fact(s) to global memory.`);
  } finally {
    rl.close();
  }
}
