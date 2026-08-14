// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Document Space vocabulary loader.
 *
 * Reads `config/document-schema.yaml`, the one file both ends read: collab
 * loads it here and publishes it into every project's meta document, and the
 * browser gets the same file compiled into its bundle at build time
 * (`packages/web/vite.config.mts`). The shape and the comparison live in
 * `@breatic/shared`; only the reading is here, because reading a file is
 * something the browser cannot do.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { documentSchemaConfigSchema, type DocumentSchema } from "@breatic/shared";

import { MONOREPO_ROOT } from "@core/config/env.js";

let _cached: Readonly<DocumentSchema> | null = null;

/**
 * Read on first use rather than at startup — the same lazy shape as every
 * other config loader here — which means the caller is a meta document being
 * loaded, and a bad file fails that load rather than the process. It is in the
 * image (`Dockerfile` copies `config/`, no volume overrides it) and collab's
 * own tests parse the real one, so a file that cannot be read does not reach a
 * running server in the first place.
 *
 * Cached after the first call: the file cannot change while the process runs,
 * and collab asks for it on every meta document that loads.
 * @returns The vocabulary this build publishes.
 * @throws {Error} When the file is missing, unparseable, or fails validation.
 */
export function getDocumentSchema(): Readonly<DocumentSchema> {
  if (_cached) return _cached;

  const configPath = resolve(MONOREPO_ROOT, "config/document-schema.yaml");
  const raw = readFileSync(configPath, "utf-8");
  const parsed = parse(raw) as unknown;
  const config = documentSchemaConfigSchema.parse(parsed);

  _cached = Object.freeze(config);
  return _cached;
}
