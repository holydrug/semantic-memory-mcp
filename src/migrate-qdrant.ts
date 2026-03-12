import neo4j from "neo4j-driver";
import { getConfig } from "./config.js";
import { initQdrant, type QdrantPoint } from "./qdrant.js";
import type { EmbedFn } from "./types.js";

interface MigrateFlags {
  reconcile: boolean;
  recreate: boolean;
  reEmbed: boolean;
}

export async function runMigrateQdrant(flags: MigrateFlags): Promise<void> {
  const config = getConfig();

  if (!config.qdrantUrl) {
    console.error("Error: QDRANT_URL is required for migration.");
    process.exit(1);
  }

  // Connect to Neo4j
  const driver = neo4j.driver(
    config.neo4jUri,
    neo4j.auth.basic(config.neo4jUser, config.neo4jPassword),
  );

  // Connect to Qdrant
  const qdrant = initQdrant(config.qdrantUrl, config.qdrantCollection, config.qdrantApiKey);

  try {
    // Stage 0: Init
    if (flags.recreate) {
      console.log("Dropping existing collection...");
      try {
        const { QdrantClient } = await import("@qdrant/js-client-rest");
        const client = new QdrantClient({ url: config.qdrantUrl, apiKey: config.qdrantApiKey });
        await client.deleteCollection(config.qdrantCollection);
        console.log("Collection dropped.");
      } catch {
        // Collection may not exist
      }
    }

    await qdrant.ensureCollection(config.embeddingDim);
    console.log(`Collection '${config.qdrantCollection}' ready (dim=${config.embeddingDim}).`);

    // Init embeddings if re-embed mode
    let embed: EmbedFn | undefined;
    if (flags.reEmbed) {
      const { initEmbeddings } = await import("./embeddings.js");
      embed = await initEmbeddings();
      console.log("Re-embed mode: will regenerate mismatched embeddings.");
    }

    // Stage 1: Upsert
    const session = driver.session();
    try {
      const result = await session.run(
        `MATCH (subj:Entity)-[:SUBJECT_OF]->(f:Fact)-[:OBJECT_IS]->(obj:Entity)
         RETURN id(f) AS factId,
                subj.name AS subject,
                f.predicate AS predicate,
                obj.name AS object,
                f.content AS fact,
                f.context AS context,
                f.source AS source,
                f.scope_candidate AS scopeCandidate,
                f.embedding AS embedding,
                f.created_at AS createdAt,
                f.layer AS layer`
      );

      let points: QdrantPoint[] = [];
      let total = 0;
      let skipped = 0;
      let reEmbedded = 0;

      for (const record of result.records) {
        const factId = record.get("factId").toNumber();
        let embedding = record.get("embedding");

        if (!embedding || !Array.isArray(embedding) || embedding.length === 0) {
          if (embed) {
            // Re-embed from fact content
            const fact = record.get("fact") as string;
            if (!fact) { skipped++; continue; }
            const newEmb = await embed(fact);
            embedding = Array.from(newEmb);
            reEmbedded++;
            // Update Neo4j with new embedding
            await session.run(
              "MATCH (f:Fact) WHERE id(f) = $id SET f.embedding = $emb",
              { id: neo4j.int(factId), emb: embedding }
            );
          } else {
            skipped++;
            continue;
          }
        } else if (embedding.length !== config.embeddingDim) {
          if (embed) {
            // Dimension mismatch — re-embed
            const fact = record.get("fact") as string;
            if (!fact) { skipped++; continue; }
            const newEmb = await embed(fact);
            embedding = Array.from(newEmb);
            reEmbedded++;
            // Update Neo4j with new embedding
            await session.run(
              "MATCH (f:Fact) WHERE id(f) = $id SET f.embedding = $emb",
              { id: neo4j.int(factId), emb: embedding }
            );
          } else {
            skipped++;
            if (skipped <= 5) {
              console.error(`[migrate] Skipping fact ${factId}: dim=${embedding.length}, expected ${config.embeddingDim} (use --re-embed to fix)`);
            }
            continue;
          }
        }

        const createdAt = record.get("createdAt");
        const createdAtStr = createdAt?.toString?.() ?? new Date().toISOString();

        points.push({
          id: factId,
          vector: embedding as number[],
          payload: {
            layer: (record.get("layer") as string) ?? null,
            subject: record.get("subject") as string,
            predicate: record.get("predicate") as string,
            object: record.get("object") as string,
            fact: record.get("fact") as string,
            context: (record.get("context") as string) || "",
            source: (record.get("source") as string) || "",
            scope_candidate: (record.get("scopeCandidate") as string) ?? null,
            created_at: createdAtStr,
          },
        });

        // Batch upsert by 100
        if (points.length >= 100) {
          await qdrant.batchUpsert(points);
          total += points.length;
          console.log(`  Upserted ${total} facts (${reEmbedded} re-embedded)...`);
          points = [];
        }
      }

      // Flush remaining
      if (points.length > 0) {
        await qdrant.batchUpsert(points);
        total += points.length;
      }

      console.log(`Migrated ${total} facts to Qdrant (${skipped} skipped, ${reEmbedded} re-embedded)`);

      // Stage 2: Reconciliation
      if (flags.reconcile) {
        console.log("Running reconciliation...");

        const qdrantIds = new Set(await qdrant.scrollIds());

        const neo4jResult = await session.run(
          "MATCH (s)-[:SUBJECT_OF]->(f:Fact)-[:OBJECT_IS]->(o) RETURN id(f) AS id"
        );
        const neo4jIds = new Set(neo4jResult.records.map(r => r.get("id").toNumber()));

        const orphans = [...qdrantIds].filter(id => !neo4jIds.has(id));

        if (orphans.length > 0) {
          await qdrant.deleteMany(orphans);
        }

        console.log(`Reconciled: deleted ${orphans.length} orphan points`);
      }
    } finally {
      await session.close();
    }
  } finally {
    await driver.close();
  }
}
