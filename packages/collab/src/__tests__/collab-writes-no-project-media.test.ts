// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * Collab writes only `project_activities`, `account_activity_events` and `project_edits` (packages/collab/AGENTS.md):
 * Project media relations are written at the entry points that bring media into a Space, so storing, loading and
 * duplicating a document never reads or writes them (inner#2171 design §5.5).
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(import.meta.dirname, "..");
const FORBIDDEN = /projectAssetReferenceService|referenceRegisteredProjectMedia|recordProjectAssetReferences|project_asset_refs|projectAssetRefs|space-media-acceptance/;

/**
 * Every production source file under collab's `src`.
 * @param dir - Where to start.
 * @returns Their paths.
 */
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "__tests__" ? [] : sources(path);
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

describe("collab and Project media relations", () => {
  it("names no Project media relation write anywhere in its source", () => {
    const offenders = sources(SRC).filter((path) => FORBIDDEN.test(readFileSync(path, "utf8"))).map((path) => relative(SRC, path));
    expect(offenders).toEqual([]);
  });
});
