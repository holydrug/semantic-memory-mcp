/**
 * Extraction strategy interface and shared types for Step 12.
 *
 * Each strategy extracts structured facts from files of a specific type.
 */

import type { Config } from "../../config.js";

export interface ExtractedFact {
  subject: string;
  predicate: string;
  object: string;
  fact: string;
  context: string;
  source: string;
  version?: string;
}

export interface ExtractionStrategy {
  name: string;
  extract(
    files: string[],
    context: string,
    config: Config,
  ): Promise<ExtractedFact[]>;
}
