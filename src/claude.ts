import { execFile } from "node:child_process";

/**
 * Extract JSON from arbitrary Claude CLI output.
 * Handles: raw JSON, ```json...``` wrapping, preamble/trailing text.
 * Uses balanced bracket matching to find the first valid JSON object or array.
 */
export function extractJSON(raw: string): unknown {
  const openers = new Set(["{", "["]);
  const closers: Record<string, string> = { "{": "}", "[": "]" };

  for (let start = 0; start < raw.length; start++) {
    const ch = raw[start]!;
    if (!openers.has(ch)) continue;

    const closer = closers[ch]!;
    let depth = 1;

    for (let i = start + 1; i < raw.length; i++) {
      if (raw[i] === ch) depth++;
      else if (raw[i] === closer) depth--;

      if (depth === 0) {
        try {
          return JSON.parse(raw.slice(start, i + 1));
        } catch {
          // Not valid JSON despite balanced brackets — try next opener
          break;
        }
      }
    }
  }

  throw new Error(`No valid JSON found in Claude response (${raw.length} chars)`);
}

/**
 * Error thrown when Claude CLI subprocess fails after all retry attempts.
 * Never causes process.exit — MCP server catches this and returns error response.
 */
export class ClaudeCliError extends Error {
  constructor(message: string, public readonly attempts: number) {
    super(message);
    this.name = "ClaudeCliError";
  }
}

export interface SpawnClaudeOpts {
  prompt: string;
  model: string;        // "sonnet"
  maxTurns?: number;    // default: 1
  timeout?: number;     // ms, default: 30_000
  claudePath?: string;  // path to claude binary, default: "claude"
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Spawn Claude CLI subprocess, parse JSON response.
 *
 * Retry policy:
 * - Process error (exit code != 0) -> 1 retry, 2s delay
 * - JSON parse failure -> throw immediately (no retry)
 * - Timeout -> throw immediately (no retry)
 *
 * Never calls process.exit(). Always throws ClaudeCliError on failure.
 */
export async function spawnClaude<T>(opts: SpawnClaudeOpts): Promise<T> {
  const claudeBin = opts.claudePath ?? "claude";
  const args = [
    "--model", opts.model,
    "--max-turns", String(opts.maxTurns ?? 1),
    "--print",
    "-p", opts.prompt,
  ];

  const timeoutMs = opts.timeout ?? 30_000;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await sleep(2_000);

    try {
      const stdout = await new Promise<string>((resolve, reject) => {
        const child = execFile(
          claudeBin,
          args,
          { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 },
          (error, stdout) => {
            if (error) {
              reject(error);
              return;
            }
            resolve(stdout);
          },
        );
        // Prevent unhandled error on the child process
        child.on("error", () => { /* handled by execFile callback */ });
      });

      // No retry on JSON failures — throw immediately
      return extractJSON(stdout) as T;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("No valid JSON")) throw err; // no retry
      if (msg.includes("TIMEOUT") || msg.includes("timed out") || msg.includes("ETIMEDOUT")) throw err; // no retry
      lastError = err instanceof Error ? err : new Error(msg);
      continue; // retry on process errors
    }
  }

  throw new ClaudeCliError(
    `Claude CLI failed after 2 attempts: ${lastError!.message}`,
    2,
  );
}
