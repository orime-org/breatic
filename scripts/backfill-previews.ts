// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Cuts the previews for images stored before previews existed (inner#1320).
 *
 * Every stored image has a 576-wide WebP beside it, cut when it is uploaded.
 * This asks the ingest Worker to cut the ones that are missing, through the
 * same read the deferred cover and avatar reads use. A preview already there
 * is left alone, so running it twice is a no-op.
 *
 * The same read measures the image again. A row whose size disagrees gets the
 * new size: rows measured before the first frame's rotation was read hold a
 * phone photo's pair the wrong way round, and every dedup hit copies it.
 *
 * Each read starts a container. Run it once per environment before the pages
 * that show previews ship, and away from smoke runs and busy hours: it takes
 * instances away from live uploads.
 *
 * Usage, from the repository root:
 *   pnpm db:backfill-previews
 *   pnpm db:backfill-previews --concurrency 2
 */

import { findRoot, loadEnv } from "./load-env.js";
import { outcomeOf, sizeCorrection } from "./backfill-previews-plan.mjs";

const ROOT = findRoot();
loadEnv(ROOT);

const core = (await import("../packages/core/dist/index.js")) as {
  initCore: (env: NodeJS.ProcessEnv) => void;
  env: { INGEST_BASE_URL: string; INGEST_SHARED_SECRET: string };
  rawPg: (s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown[]>;
};
core.initCore(process.env);
const shared = (await import("../packages/shared/dist/index.js")) as {
  PREVIEW_OUTCOMES: readonly string[];
  readStoredMediaAtIngest: (
    url: string,
    secret: string,
    about: { storageKey: string; contentType: string; limits: unknown; wantPreview: boolean },
  ) => Promise<{ width: number | null; height: number | null; preview?: string }>;
};
const domain = (await import("../packages/domain/dist/index.js")) as {
  assetService: { mediaLimits: () => unknown };
};

/** One image row: the oldest live row for each stored key. */
interface ImageRow {
  id: string;
  storage_key: string;
  mime_type: string;
  width: number | null;
  height: number | null;
}

const flag = process.argv.indexOf("--concurrency");
const concurrency = flag === -1 ? 1 : Math.max(1, Number(process.argv[flag + 1]) || 1);

const rows = (await core.rawPg`
  SELECT DISTINCT ON (storage_key) id, storage_key, mime_type, width, height
  FROM studio_assets
  WHERE mime_type LIKE 'image/%' AND deleted_at IS NULL
  ORDER BY storage_key, created_at
`) as ImageRow[];
console.log(`${rows.length} stored images`);

const limits = domain.assetService.mediaLimits();
const counts = new Map<string, number>(
  [...shared.PREVIEW_OUTCOMES, "missing"].map((outcome) => [outcome, 0]),
);
const failedKeys: string[] = [];
let resized = 0;
let next = 0;

/** Read the next row until none are left. */
async function work(): Promise<void> {
  while (next < rows.length) {
    const row = rows[next++]!;
    let thrown: unknown;
    const read = await shared
      .readStoredMediaAtIngest(core.env.INGEST_BASE_URL, core.env.INGEST_SHARED_SECRET, {
        storageKey: row.storage_key,
        contentType: row.mime_type,
        limits,
        wantPreview: true,
      })
      .catch((err: unknown) => {
        thrown = err;
        return null;
      });
    const outcome = outcomeOf(read, thrown);
    if (outcome === "failed" && read === null) console.error("read failed", row.storage_key, thrown);
    counts.set(outcome, (counts.get(outcome) ?? 0) + 1);
    if (outcome === "failed") failedKeys.push(row.storage_key);
    const size = read === null ? null : sizeCorrection(row, read);
    if (size !== null) {
      await core.rawPg`
        UPDATE studio_assets
        SET width = ${size.width}, height = ${size.height}
        WHERE storage_key = ${row.storage_key} AND deleted_at IS NULL
      `;
      resized += 1;
    }
  }
}

await Promise.all(Array.from({ length: concurrency }, () => work()));

console.log(Object.fromEntries(counts), `sizes corrected: ${resized}`);
if (failedKeys.length > 0) {
  // A container that ran out of time fails the same way as one that could not
  // be read; a second run tells the two apart.
  console.log("no preview was cut for these:");
  for (const key of failedKeys) console.log(" ", key);
}
process.exit(0);
