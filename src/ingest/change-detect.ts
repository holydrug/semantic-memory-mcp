/**
 * Change detection for incremental re-ingest.
 *
 * Per-file content hashing (SHA-256) compared against stored hashes
 * to determine which files need re-processing.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

// ── Content hashing ──────────────────────────────────────────────────────

/**
 * Compute SHA-256 hash of a file's content.
 * Returns the hash prefixed with "sha256:" for clarity.
 */
export function computeFileHash(filePath: string): string {
  const content = readFileSync(filePath);
  const hash = createHash("sha256").update(content).digest("hex");
  return `sha256:${hash}`;
}

// ── Change detection ────────────────────────────────────────────────────

export interface ChangeDetectionResult {
  changed: string[];
  added: string[];
  deleted: string[];
  unchanged: string[];
}

/**
 * Compare current file hashes against stored hashes to detect changes.
 *
 * @param current  Map of filePath -> contentHash for current files
 * @param stored   Map of filePath -> contentHash from last ingest
 * @returns Lists of changed, added, deleted, and unchanged files
 */
export function detectChanges(
  current: Map<string, string>,
  stored: Map<string, string>,
): ChangeDetectionResult {
  const changed: string[] = [];
  const added: string[] = [];
  const unchanged: string[] = [];

  for (const [file, hash] of current) {
    const storedHash = stored.get(file);
    if (storedHash === undefined) {
      added.push(file);
    } else if (storedHash !== hash) {
      changed.push(file);
    } else {
      unchanged.push(file);
    }
  }

  // Files in stored but not in current -> deleted
  const deleted: string[] = [];
  for (const file of stored.keys()) {
    if (!current.has(file)) {
      deleted.push(file);
    }
  }

  return { changed, added, deleted, unchanged };
}

/**
 * Compute hashes for a list of files.
 * Returns a Map of filePath -> contentHash.
 * Files that can't be read are silently skipped.
 */
export function computeHashes(files: string[]): Map<string, string> {
  const hashes = new Map<string, string>();
  for (const file of files) {
    try {
      hashes.set(file, computeFileHash(file));
    } catch {
      // Skip files that can't be read
    }
  }
  return hashes;
}
