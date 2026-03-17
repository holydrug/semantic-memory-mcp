import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config.js";
import type { StorageBackend, EmbedFn } from "../types.js";
import { isDualBackend } from "../types.js";
import { classifyScope } from "../classify.js";

/**
 * Validate a URL: only HTTP/HTTPS, block localhost and private IPs.
 * Returns null if valid, error string if invalid.
 */
export function validateUrl(rawUrl: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return `Invalid URL: ${rawUrl}`;
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return `Only HTTP/HTTPS URLs are allowed, got: ${parsed.protocol}`;
  }

  const hostname = parsed.hostname.toLowerCase();

  // Block localhost
  if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1") {
    return `Blocked: localhost URLs are not allowed (SSRF protection)`;
  }

  // Block private IP ranges
  if (isPrivateIp(hostname)) {
    return `Blocked: private IP addresses are not allowed (SSRF protection)`;
  }

  return null;
}

/**
 * Check if an IP address is in a private range.
 * Handles: 127.0.0.0/8, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 0.0.0.0
 */
export function isPrivateIp(hostname: string): boolean {
  // Check if it looks like an IPv4 address
  const ipv4Match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  if (!ipv4Match) return false;

  const a = parseInt(ipv4Match[1]!, 10);
  const b = parseInt(ipv4Match[2]!, 10);

  // 0.0.0.0
  if (a === 0) return true;
  // 127.0.0.0/8
  if (a === 127) return true;
  // 10.0.0.0/8
  if (a === 10) return true;
  // 172.16.0.0/12 (172.16.x.x - 172.31.x.x)
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.168.0.0/16
  if (a === 192 && b === 168) return true;
  // 169.254.0.0/16 (link-local)
  if (a === 169 && b === 254) return true;

  return false;
}

/**
 * Strip HTML tags and extract text content.
 */
function htmlToText(html: string): string {
  return html
    // Remove script and style blocks
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    // Replace block-level tags with newlines
    .replace(/<\/(p|div|h[1-6]|li|tr|br|hr)[^>]*>/gi, "\n")
    .replace(/<(br|hr)[^>]*\/?>/gi, "\n")
    // Remove remaining tags
    .replace(/<[^>]+>/g, "")
    // Decode common HTML entities
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    // Clean up whitespace
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

interface ExtractedFact {
  subject: string;
  predicate: string;
  object: string;
  fact: string;
  context: string;
}

/**
 * Extract facts from content using basic parsing.
 * Full implementation will use Claude CLI (Step 04).
 */
function extractFacts(
  content: string,
  source: string,
  _version?: string,
  _context?: string,
): ExtractedFact[] {
  const facts: ExtractedFact[] = [];

  // Simple line-based extraction — real implementation uses Claude CLI
  const lines = content.split("\n").filter((l) => l.trim().length > 20);

  for (const line of lines.slice(0, 50)) {
    const trimmed = line.trim();
    // Skip very short or very long lines
    if (trimmed.length < 20 || trimmed.length > 500) continue;

    // Detect breaking changes
    if (/breaking|removed|deprecated/i.test(trimmed)) {
      facts.push({
        subject: source,
        predicate: "breaking_change",
        object: trimmed.slice(0, 100),
        fact: trimmed,
        context: `Extracted from URL content for ${source}`,
      });
    }
  }

  return facts;
}

/** Fetch URL content, with timeout */
async function fetchContent(url: string): Promise<{ text: string; contentType: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "semantic-memory-mcp/1.0",
        "Accept": "text/html, text/markdown, text/plain, */*",
      },
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const contentType = response.headers.get("content-type") ?? "text/plain";
    const rawText = await response.text();
    const text = contentType.includes("html") ? htmlToText(rawText) : rawText;

    return { text, contentType };
  } finally {
    clearTimeout(timeout);
  }
}

export function registerIngestUrlTool(
  server: McpServer,
  db: StorageBackend,
  embed: EmbedFn,
  _config: Config,
): void {
  server.tool(
    "memory_ingest_url",
    "Ingest content from a URL (changelog, docs, release notes) into the knowledge base. " +
    "Fetches the URL, extracts facts, and stores them. " +
    "Supports version tracking and migration diffs.",
    {
      url: z
        .string()
        .describe("URL to fetch (HTTP/HTTPS only)"),
      source: z
        .string()
        .describe("Source tag (e.g. 'platform-lib:changelog')"),
      version: z
        .string()
        .optional()
        .describe("Version tag (e.g. '80')"),
      old_version: z
        .string()
        .optional()
        .describe("Previous version for migration diff (e.g. '70')"),
      context: z
        .string()
        .optional()
        .describe("Hint for extraction (e.g. 'Extract breaking changes, migration steps')"),
    },
    async ({ url, source, version, old_version: _oldVersion, context }) => {
      // 1. Validate URL
      const urlError = validateUrl(url);
      if (urlError) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ error: urlError }),
          }],
        };
      }

      // 2. Fetch content
      let text: string;
      try {
        const result = await fetchContent(url);
        text = result.text;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ error: `Failed to fetch URL: ${msg}` }),
          }],
        };
      }

      if (!text || text.trim().length === 0) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ error: "URL returned empty content" }),
          }],
        };
      }

      // 3. Extract facts from content
      const extracted = extractFacts(text, source, version, context);

      // 4. Store each fact
      const errors: string[] = [];
      let factsStored = 0;
      let breakingChanges = 0;
      let deprecations = 0;
      let newApis = 0;
      let migrationSteps = 0;
      let superseded = 0;

      // Determine target backend for scope routing
      const scope = isDualBackend(db) ? classifyScope("has_fact") : null;
      const target = scope && isDualBackend(db) ? db.getLayerBackend(scope) : db;

      for (const fact of extracted) {
        try {
          const [subjectEmb, objectEmb, factEmb] = await Promise.all([
            embed(fact.subject),
            embed(fact.object),
            embed(fact.fact),
          ]);

          const subjectId = await target.findOrCreateEntity(fact.subject, subjectEmb);
          const objectId = await target.findOrCreateEntity(fact.object, objectEmb);

          await target.storeFact({
            subjectId,
            predicate: fact.predicate,
            objectId,
            content: fact.fact,
            context: fact.context,
            source: `${source}${version ? `@${version}` : ""}`,
            embedding: factEmb,
          });

          factsStored++;

          // Count by type
          if (fact.predicate.startsWith("breaking_change")) breakingChanges++;
          else if (fact.predicate.startsWith("deprecated")) deprecations++;
          else if (fact.predicate.startsWith("new_api")) newApis++;
          else if (fact.predicate === "migration_step") migrationSteps++;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          errors.push(`Failed to store fact: ${msg}`);
        }
      }

      const result = {
        factsExtracted: extracted.length,
        factsStored,
        breakingChanges,
        deprecations,
        newApis,
        migrationSteps,
        superseded,
        errors,
      };

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify(result),
        }],
      };
    },
  );
}
