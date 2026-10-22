// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Reads the peaks of audio stored before peaks existed (inner#1305 §4.4).
 *
 * Every audio row an upload writes gets a peaks file beside it, read by the
 * audio-peaks job after the row registers. Audio stored before that, and rows
 * whose job could not be queued or ran out of retries, are missing theirs.
 * This asks the ingest Worker to read the ones that are missing, through the
 * same /media read the job uses. Peaks already there are left alone, so
 * running it twice is a no-op.
 *
 * Each read starts a media container and decodes the whole object. Run it
 * once per environment after the ingest Worker, the worker and the server
 * that queue peaks are deployed, and away from smoke runs and busy hours: it
 * takes instances away from live uploads.
 *
 * Usage, from the repository root:
 *   pnpm db:backfill-peaks
 *   pnpm db:backfill-peaks --concurrency 2
 */

import { findRoot, loadEnv } from "./load-env.js";
import { outcomeOf } from "./backfill-previews-plan.mjs";

const ROOT = findRoot();
loadEnv(ROOT);

const core = (await import("../packages/core/dist/index.js")) as {
  initCore: (env: NodeJS.ProcessEnv) => void;
  env: { INGEST_BASE_URL: string; INGEST_SHARED_SECRET: string };
  rawPg: (s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown[]>;
  budgetDeadlineFrom: (startedAt: number) => number;
};
core.initCore(process.env);
const shared = (await import("../packages/shared/dist/index.js")) as {
  PREVIEW_OUTCOMES: readonly string[];
  readStoredMediaAtIngest: (
    url: string,
    secret: string,
    about: { storageKey: string; contentType: string; deadlineAt: number; wantPeaks: boolean },
  ) => Promise<{ peaks?: string }>;
};

/** One audio row: the oldest live row for each stored key. */
interface AudioRow {
  storage_key: string;
  mime_type: string;
}

const flag = process.argv.indexOf("--concurrency");
const concurrency = flag === -1 ? 1 : Math.max(1, Number(process.argv[flag + 1]) || 1);

const rows = (await core.rawPg`
  SELECT DISTINCT ON (storage_key) storage_key, mime_type
  FROM studio_assets
  WHERE mime_type LIKE 'audio/%' AND deleted_at IS NULL
  ORDER BY storage_key, created_at
`) as AudioRow[];
console.log(`${rows.length} stored audio objects`);

// Each read is its own task: two hours from when it starts (inner#1367).
const counts = new Map<string, number>(
  [...shared.PREVIEW_OUTCOMES, "missing"].map((outcome) => [outcome, 0]),
);
const failedKeys: string[] = [];
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
        deadlineAt: core.budgetDeadlineFrom(Date.now()),
        wantPeaks: true,
      })
      .catch((err: unknown) => {
        thrown = err;
        return null;
      });
    const outcome = outcomeOf(read, thrown, "peaks");
    if (outcome === "failed" && read === null) console.error("read failed", row.storage_key, thrown);
    counts.set(outcome, (counts.get(outcome) ?? 0) + 1);
    if (outcome === "failed") failedKeys.push(row.storage_key);
  }
}

await Promise.all(Array.from({ length: concurrency }, () => work()));

console.log(Object.fromEntries(counts));
if (failedKeys.length > 0) {
  // A container that ran out of time fails the same way as one that could not
  // be read; a second run tells the two apart.
  console.log("no peaks were read for these:");
  for (const key of failedKeys) console.log(" ", key);
}
process.exit(0);
