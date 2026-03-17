import { execFile } from "node:child_process";

/**
 * Error thrown when Claude CLI invocation fails.
 * Never calls process.exit — the MCP server catches this and returns an error response.
 */
export class ClaudeCliError extends Error {
  constructor(
    message: string,
    public readonly attempts: number,
  ) {
    super(message);
    this.name = "ClaudeCliError";
  }
}

/**
 * Extract JSON from arbitrary text output (handles ```json blocks, preamble text, etc.)
 * Uses balanced bracket matching to find the first valid JSON object or array.
 */
export function extractJSON<T>(text: string): T {
  // Find the first { or [
  let startIdx = -1;
  let openChar = "";
  let closeChar = "";

  for (let i = 0; i < text.length; i++) {
    if (text[i] === "{" || text[i] === "[") {
      startIdx = i;
      openChar = text[i]!;
      closeChar = openChar === "{" ? "}" : "]";
      break;
    }
  }

  if (startIdx === -1) {
    throw new ClaudeCliError("No valid JSON found in output", 0);
  }

  // Balanced bracket matching
  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = startIdx; i < text.length; i++) {
    const ch = text[i]!;

    if (escape) {
      escape = false;
      continue;
    }

    if (ch === "\\") {
      escape = true;
      continue;
    }

    if (ch === '"') {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (ch === openChar) {
      depth++;
    } else if (ch === closeChar) {
      depth--;
      if (depth === 0) {
        const jsonStr = text.slice(startIdx, i + 1);
        try {
          return JSON.parse(jsonStr) as T;
        } catch {
          throw new ClaudeCliError("No valid JSON found in output", 0);
        }
      }
    }
  }

  throw new ClaudeCliError("No valid JSON found in output", 0);
}

export interface SpawnClaudeOpts {
  prompt: string;
  model: string;
  maxTurns?: number;
  timeout?: number;
  claudePath?: string;
}

/**
 * Spawn Claude CLI as a subprocess and return parsed JSON response.
 *
 * Retry policy:
 * - Process error (exit code != 0) -> 1 retry, 2s delay
 * - JSON parse failure -> throw immediately (no retry)
 * - Timeout -> throw immediately (no retry)
 */
export async function spawnClaude<T>(opts: SpawnClaudeOpts): Promise<T> {
  const {
    prompt,
    model,
    maxTurns = 1,
    timeout = 30_000,
    claudePath = "claude",
  } = opts;

  const args = [
    "--model", model,
    "--max-turns", String(maxTurns),
    "--print",
    "-p", prompt,
  ];

  const MAX_ATTEMPTS = 2;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const output = await execClaude(claudePath, args, timeout);
      return extractJSON<T>(output);
    } catch (err) {
      if (err instanceof ClaudeCliError && err.message === "No valid JSON found in output") {
        // JSON parse failure -> throw immediately
        throw err;
      }

      if (err instanceof ClaudeCliError && err.message.includes("timed out")) {
        // Timeout -> throw immediately
        throw err;
      }

      // Process error -> retry once with 2s delay
      if (attempt < MAX_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        continue;
      }

      throw new ClaudeCliError(
        `Claude CLI failed after ${attempt} attempt(s): ${err instanceof Error ? err.message : String(err)}`,
        attempt,
      );
    }
  }

  // Should not reach here, but TypeScript requires it
  throw new ClaudeCliError("Unexpected: exhausted all attempts", MAX_ATTEMPTS);
}

function execClaude(bin: string, args: string[], timeout: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(bin, args, { timeout, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        if ("killed" in err && err.killed) {
          reject(new ClaudeCliError(`Claude CLI timed out after ${timeout}ms`, 0));
          return;
        }
        reject(new ClaudeCliError(
          `Claude CLI exited with error: ${err.message}${stderr ? `\nstderr: ${stderr}` : ""}`,
          0,
        ));
        return;
      }
      resolve(stdout);
    });

    // Additional safety: kill on timeout (for cases where execFile timeout doesn't fire)
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, timeout + 1000);

    child.on("close", () => clearTimeout(timer));
  });
}
