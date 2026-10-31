// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { ProjectMediaBackfillPosition } from "../packages/core/src/asset/project-media-backfill.js";
import { parseArgs } from "node:util";

/** Explicit report destination and operator-selected maintenance mode. */
export type ProjectMediaBackfillOptions = { help: true } | {
  help: false;
  mode: "report" | "apply";
  outputPath: string;
  resume?: ProjectMediaBackfillPosition;
};

/**
 * Parse maintenance arguments before loading application configuration.
 * @param args - Arguments after the script path.
 * @returns Help or an explicit private JSONL destination and resume position.
 * @throws {Error} When flags, destination or the resume tuple are malformed.
 */
export function parseProjectMediaBackfillOptions(args: readonly string[]): ProjectMediaBackfillOptions {
  const { values, tokens } = parseArgs({
    args: [...args], strict: true, allowPositionals: false, tokens: true,
    options: {
      help: { type: "boolean" }, apply: { type: "boolean" }, output: { type: "string" },
      "resume-pass": { type: "string" }, "resume-source": { type: "string" }, "resume-cursor": { type: "string" },
    },
  });
  const seen = new Set<string>();
  for (const token of tokens) {
    if (token.kind !== "option") continue;
    if (seen.has(token.name)) throw new Error(`Option --${token.name} may occur only once`);
    seen.add(token.name);
  }
  if (values.help === true) return { help: true };
  const outputPath = values.output;
  if (outputPath === undefined || !outputPath.endsWith(".jsonl")) throw new Error("An explicit --output path ending in .jsonl is required");
  const pass = values["resume-pass"];
  const source = values["resume-source"];
  const cursor = values["resume-cursor"];
  let resume: ProjectMediaBackfillPosition | undefined;
  if (pass !== undefined || source !== undefined || cursor !== undefined) {
    if ((pass !== "initial" && pass !== "verification") || source === undefined || source.length === 0 || cursor === undefined || cursor.length === 0) {
      throw new Error("Resume requires --resume-pass initial|verification, --resume-source and --resume-cursor");
    }
    resume = { pass, source, cursor };
  }
  return { help: false, mode: values.apply === true ? "apply" : "report", outputPath, ...(resume === undefined ? {} : { resume }) };
}
