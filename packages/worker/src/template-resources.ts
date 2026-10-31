// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Put the files generation templates bring (inner#1345) at our fixed public
 * address (`base_url` in config/voice-samples.json), where every deployment
 * fetches them from when a template is applied. Run as
 * `pnpm template-resources <dir>` by whoever adds a template file, with
 * storage settings that publish to that address; `<dir>` holds one folder per
 * template id with its files in it. Files already served are left alone. A
 * run that leaves any file a template declares unserved exits non-zero.
 */

// MUST be first: reads process.env + initCore before any env.* read.
import "@worker/bootstrap-config.js";

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { getStorageAdapter, logger } from "@breatic/core";
import { typeFromAddress, voiceSampleUrl } from "@breatic/domain";
import { GENERATION_TEMPLATES, httpRequest } from "@breatic/shared";

import { assertUploadsReachSampleAddress, servedFromHead } from "@worker/voice-samples/sync.js";

/**
 * Whether the public address already serves a key.
 * @param key - The storage key.
 * @returns Whether it does.
 * @throws {Error} When the address answers neither a success nor 404.
 */
async function served(key: string): Promise<boolean> {
  return servedFromHead(key, (await httpRequest(voiceSampleUrl(key), { method: "HEAD" }, { replaySafe: true })).status);
}

/**
 * Every file under the directory, keyed as `templates/<template id>/<file>`.
 * @param dir - The directory, one folder per template id.
 * @returns Each key and the file it comes from.
 * @throws {Error} When the directory cannot be read.
 */
async function filesIn(dir: string): Promise<Array<{ key: string; path: string }>> {
  const folders = await readdir(dir, { withFileTypes: true });
  const found: Array<{ key: string; path: string }> = [];
  for (const folder of folders) {
    if (!folder.isDirectory()) continue;
    for (const file of await readdir(join(dir, folder.name), { withFileTypes: true })) {
      if (file.isFile()) found.push({ key: `templates/${folder.name}/${file.name}`, path: join(dir, folder.name, file.name) });
    }
  }
  return found;
}

/**
 * Upload what is missing, then check every declared path, and exit with the outcome.
 * @returns Nothing; the process exits.
 * @throws {Error} When no directory is given.
 */
async function main(): Promise<void> {
  const dir = process.argv[2];
  if (dir === undefined) throw new Error("usage: pnpm template-resources <dir>");
  const storage = await getStorageAdapter();
  assertUploadsReachSampleAddress((key) => storage.publicUrl(key), voiceSampleUrl);

  let uploaded = 0;
  for (const { key, path } of await filesIn(dir)) {
    if (await served(key)) continue;
    const type = typeFromAddress(voiceSampleUrl(key));
    if (type === undefined) {
      logger.error({ key }, "template_resource_type_unknown");
      continue;
    }
    await storage.upload(key, await readFile(path), type);
    uploaded += 1;
  }

  const declared = GENERATION_TEMPLATES.flatMap((template) =>
    template.nodes.flatMap((node) => (node.role === "source" ? [node.resource] : [])),
  );
  const missing: string[] = [];
  for (const key of declared) if (!(await served(key))) missing.push(key);
  logger.info({ uploaded, declared: declared.length, missing: missing.length }, "template_resources_synced");
  for (const key of missing) logger.error({ key }, "template_resource_missing");
  process.exit(missing.length === 0 ? 0 : 1);
}

main().catch((err: unknown) => {
  logger.error({ err }, "template_resources_sync_failed");
  process.exit(1);
});
