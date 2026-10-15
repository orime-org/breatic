// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Soft-deletes the Space content rows no Space owns any more (inner#1140).
 *
 * A project holds at most 200 live Spaces, and collab checks that against the
 * number of live content rows in the yjs database. Before the cap, three paths
 * could leave a live row with no Space in the project's meta doc: a store that
 * revived a deleted Space's row, a project duplicate that copied the source's
 * deleted rows, and a create whose meta write failed. Those rows make a
 * project read fuller than it is. The code paths are fixed; this clears what
 * they left behind.
 *
 * For each project with a live meta doc it lists the live content rows the
 * meta does not list and nobody touched for an hour. A project without a live
 * meta doc is skipped: with no Space list there is nothing to compare against.
 *
 * Usage, from the repository root, once per environment:
 *   pnpm db:repair-space-rows            report only
 *   pnpm db:repair-space-rows --apply    soft-delete what the report lists
 */

import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { findRoot, loadEnv } from "./load-env.js";
import { APPLY_SQL, staleContentRows } from "./repair-space-rows-plan.mjs";

const ROOT = findRoot();
loadEnv(ROOT);

interface UnsafeSql {
  (s: TemplateStringsArray, ...v: unknown[]): Promise<unknown[]>;
  unsafe: (query: string, params: unknown[]) => Promise<{ count: number }>;
}

const core = (await import("../packages/core/dist/index.js")) as {
  initCore: (env: NodeJS.ProcessEnv) => void;
  yjsRawPg: UnsafeSql;
};
core.initCore(process.env);

// The root has no yjs of its own; core's copy decodes a meta doc as well as any.
const yjsEntry = createRequire(new URL("../packages/core/package.json", import.meta.url)).resolve("yjs");
const Y = (await import(pathToFileURL(yjsEntry).href)) as typeof import("yjs");

/** A yjs row as the repair reads it. */
interface DocRow {
  name: string;
  data: Uint8Array;
  updatedAt: Date;
  deletedAt: Date | null;
}

/**
 * The Space ids a stored meta doc lists.
 * @param data - The meta doc state.
 * @returns The Space ids.
 */
function listedSpaceIds(data: Uint8Array): Set<string> {
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, data);
    return new Set(doc.getMap("spaces").keys());
  } finally {
    doc.destroy();
  }
}

const apply = process.argv.includes("--apply");
const metas = (await core.yjsRawPg`
  SELECT name, data FROM yjs_documents
  WHERE name LIKE 'project-%/meta' AND deleted_at IS NULL
`) as Pick<DocRow, "name" | "data">[];

const now = Date.now();
let reported = 0;
let deleted = 0;
for (const meta of metas) {
  const prefix = meta.name.slice(0, -"meta".length);
  const rows = (await core.yjsRawPg`
    SELECT name, updated_at AS "updatedAt", deleted_at AS "deletedAt" FROM yjs_documents
    WHERE starts_with(name, ${prefix}) AND name <> ${meta.name}
  `) as Omit<DocRow, "data">[];
  const stale = staleContentRows({ metaSpaceIds: listedSpaceIds(meta.data), rows, now });
  for (const name of stale) {
    reported += 1;
    if (!apply) {
      console.log("stale", name);
      continue;
    }
    const result = await core.yjsRawPg.unsafe(APPLY_SQL, [name]);
    deleted += result.count;
    console.log(result.count === 1 ? "soft-deleted" : "changed since the report, left alone", name);
  }
}

console.log(
  apply
    ? `${metas.length} projects, ${reported} stale rows, ${deleted} soft-deleted`
    : `${metas.length} projects, ${reported} stale rows; run again with --apply to soft-delete them`,
);
process.exit(0);
