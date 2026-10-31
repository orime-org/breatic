// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Rebuild historical Project media membership from explicit source records.
 *
 * Usage: pnpm db:backfill-project-media --output logs/project-media.jsonl
 * Add --apply to accept registered identities. Resume using the last emitted
 * candidate's --resume-pass, --resume-source and --resume-cursor values.
 */

import { open } from "node:fs/promises";
import { findRoot, loadEnv } from "./load-env.js";
import { parseProjectMediaBackfillOptions } from "./backfill-project-media-options.js";

const options = parseProjectMediaBackfillOptions(process.argv.slice(2));
if (options.help) {
  console.log("Usage: pnpm db:backfill-project-media --output <new-private-report.jsonl> [--apply] [--resume-pass initial|verification --resume-source <source> --resume-cursor <last-emitted-cursor>]");
} else {
  loadEnv(findRoot());
  const coreModule: unknown = await import(new URL("../packages/core/dist/index.js", import.meta.url).href);
  const core = coreModule as typeof import("../packages/core/src/index.js");
  core.initCore(process.env);
  core.loadLocales();
  const domainModule: unknown = await import(new URL("../packages/domain/dist/index.js", import.meta.url).href);
  const domain = domainModule as typeof import("../packages/domain/src/index.js");
  const { createSpaceProjectMediaBackfillSource } = await import("../packages/collab/src/services/project-media-backfill.js");
  const report = await open(options.outputPath, "wx", 0o600);
  try {
    await core.runProjectMediaBackfill({
      mode: options.mode,
      sources: [...domain.createBusinessProjectMediaBackfillSources(), createSpaceProjectMediaBackfillSource()],
      resume: options.resume,
      emit: async (record) => {
        await report.appendFile(JSON.stringify(record) + "\n");
        await report.sync();
      },
    });
    core.logger.info({ mode: options.mode, output: options.outputPath }, "Project media backfill completed");
  } catch (err) {
    core.logger.error({ err, ctx: { operation: "project_media_backfill", mode: options.mode } }, "Project media backfill failed");
    throw err;
  } finally {
    await Promise.all([
      report.close(), core.closeDb(), core.closeYjsDb(), core.closeRedis(),
      core.closeQueueRedis(), core.closeStreamRedis(), core.closeCollabRedis(), core.closeQueues(),
    ]);
  }
}
