/**
 * Claude CLI subprocess wrapper.
 *
 * All Claude CLI calls (validation, sweep, extraction) go through
 * `spawnClaude<T>()`.  Never `process.exit(1)` — always throw.
 */

import { spawn } from 'node:child_process';

// ---------------------------------------------------------------------------
// ClaudeCliError
// ---------------------------------------------------------------------------

export class ClaudeCliError extends Error {
  constructor(message: string, public readonly attempts: number) {
    super(message);
    this.name = 'ClaudeCliError';
  }
}

// ---------------------------------------------------------------------------
// extractJSON
// ---------------------------------------------------------------------------

/**
 * Extract and parse the first valid JSON object or array from arbitrary text.
 *
 * Sonnet may wrap output in ```json ... ```, add preamble text, etc.
 * We use balanced-bracket matching to locate candidates, then validate
 * with `JSON.parse`.  If a balanced substring is not valid JSON (e.g.
 * `{curly}`) we skip it and keep scanning.
 */
export function extractJSON(raw: string): unknown {
  const openers = new Set(['{', '[']);
  const closerFor: Record<string, string> = { '{': '}', '[': ']' };

  let i = 0;
  while (i < raw.length) {
    if (!openers.has(raw[i]!)) {
      i++;
      continue;
    }

    const opener = raw[i]!;
    const closer = closerFor[opener]!;
    const start = i;
    let depth = 1;
    i++; // move past the opener

    while (i < raw.length && depth > 0) {
      if (raw[i] === opener) {
        depth++;
      } else if (raw[i] === closer) {
        depth--;
      }
      i++;
    }

    if (depth === 0) {
      const candidate = raw.slice(start, i);
      try {
        return JSON.parse(candidate);
      } catch {
        // Not valid JSON — keep scanning from current position
        continue;
      }
    }
    // Unbalanced — exhausted input, fall through to error
  }

  throw new Error(`No valid JSON found in Claude response (${raw.length} chars)`);
}

// ---------------------------------------------------------------------------
// spawnClaude
// ---------------------------------------------------------------------------

export interface SpawnClaudeOpts {
  prompt: string;
  model: string;         // e.g. "sonnet"
  maxTurns?: number;     // default: 1
  timeout?: number;      // ms, default: 120_000
  claudePath?: string;   // path to claude binary, default: "claude"
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Internal exec implementation (replaceable for testing via _setExecImpl)
// ---------------------------------------------------------------------------

type ExecImpl = (args: string[], timeout: number) => Promise<string>;

function defaultExecImpl(args: string[], timeout: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn('claude', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Close stdin immediately — claude CLI hangs if stdin stays open
    proc.stdin.end();

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      proc.kill();
      const err = new Error('TIMEOUT');
      (err as unknown as Record<string, unknown>)['killed'] = true;
      reject(err);
    }, timeout);

    proc.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
      if (stdout.length > 10 * 1024 * 1024) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        proc.kill();
        reject(new Error('Max buffer exceeded (10 MB)'));
      }
    });
    proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    proc.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });

    proc.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        const err = new Error(`claude exited with code ${code}: ${stderr}`);
        (err as unknown as Record<string, unknown>)['killed'] = false;
        reject(err);
        return;
      }
      resolve(stdout);
    });
  });
}

let execImpl: ExecImpl = defaultExecImpl;

/**
 * Replace the internal exec function (for testing only).
 * Pass `null` to restore the default implementation.
 */
export function _setExecImpl(fn: ExecImpl | null): void {
  execImpl = fn ?? defaultExecImpl;
}

/**
 * Execute `claude` CLI as a child process and return parsed JSON.
 *
 * Retry policy:
 *   - Process error (exit code != 0) → 1 retry, 2 s delay
 *   - JSON parse failure            → throw immediately (no retry)
 *   - Timeout                       → throw immediately (no retry)
 */
export async function spawnClaude<T>(opts: SpawnClaudeOpts): Promise<T> {
  const args = [
    '--model', opts.model,
    '--max-turns', String(opts.maxTurns ?? 1),
    '--print',
    '-p', opts.prompt,
  ];

  const timeout = opts.timeout ?? 120_000;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await sleep(2_000);

    try {
      const stdout = await execImpl(args, timeout);
      // No retry on JSON parse failures — throw immediately
      return extractJSON(stdout) as T;
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));

      // JSON extraction failure — throw immediately, no retry
      if (error.message.includes('No valid JSON')) throw error;

      // Timeout — throw immediately, no retry
      // execFile sets `killed` on the error when the process is killed due to timeout
      const asRecord = error as unknown as Record<string, unknown>;
      if (asRecord['killed'] === true || error.message.includes('TIMEOUT') || error.message.includes('timed out')) {
        throw new ClaudeCliError(
          `Claude CLI timed out after ${timeout}ms`,
          attempt + 1,
        );
      }

      lastError = error;
      continue; // retry on process errors
    }
  }

  throw new ClaudeCliError(
    `Claude CLI failed after 2 attempts: ${lastError!.message}`,
    2,
  );
}
