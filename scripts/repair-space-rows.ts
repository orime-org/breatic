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
 * For each project with a live meta doc it lists the live Space content rows
 * the meta does not list — by full name, so a row of another kind under a
 * listed Space's id counts as unlisted — and nobody touched for an hour. A
 * project without a live meta doc is skipped: with no Space list there is
 * nothing to compare against.
 *
 * Usage, from the repository root, once per environment:
 *   pnpm db:repair-space-rows            report only
 *   pnpm db:repair-space-rows --apply    soft-delete what the report lists
 */

import { findRoot, loadEnv } from "./load-env.js";
import { APPLY_SQL, STALE_AFTER_MS, repairProject } from "./repair-space-rows-plan.mjs";

const ROOT = findRoot();
loadEnv(ROOT);

interface UnsafeSql {
  (s: TemplateStringsArray, ...v: unknown[]): Promise<unknown[]>;
  unsafe: (query: string, params: unknown[]) => Promise<{ count: number }>;
}

const core = (await import("../packages/core/dist/index.js")) as {
  initCore: (env: NodeJS.ProcessEnv) => void;
  yjsRawPg: UnsafeSql;
  listedContentDocNamesInState: (projectId: string, state: Uint8Array) => Set<string>;
};
core.initCore(process.env);
const shared = (await import("../packages/shared/dist/index.js")) as {
  parseDocName: (docName: string) => { projectId: string } | null;
  spaceContentRowPattern: (projectId: string) => string;
};

/** A yjs row as the repair reads it. */
interface DocRow {
  name: string;
  data: Uint8Array;
  updatedAt: Date;
  deletedAt: Date | null;
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
  const projectId = shared.parseDocName(meta.name)?.projectId;
  if (!projectId) continue;
  const rows = (await core.yjsRawPg`
    SELECT name, updated_at AS "updatedAt", deleted_at AS "deletedAt" FROM yjs_documents
    WHERE name ~ ${shared.spaceContentRowPattern(projectId)}
  `) as Omit<DocRow, "data">[];
  const result = await repairProject({
    listedNames: core.listedContentDocNamesInState(projectId, meta.data),
    rows,
    now,
    apply,
    softDelete: async (name: string) => (await core.yjsRawPg.unsafe(APPLY_SQL, [name, STALE_AFTER_MS])).count,
  });
  reported += result.stale.length;
  deleted += result.softDeleted.length;
  for (const name of apply ? result.softDeleted : result.stale) console.log(apply ? "soft-deleted" : "stale", name);
  for (const name of result.leftAlone) console.log("changed since the report, left alone", name);
}

console.log(
  apply
    ? `${metas.length} projects, ${reported} stale rows, ${deleted} soft-deleted`
    : `${metas.length} projects, ${reported} stale rows; run again with --apply to soft-delete them`,
);
process.exit(0);
