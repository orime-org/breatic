// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0
import { parse as parseYaml } from "yaml";
import type { Check, CheckContext, Finding } from "#repo-lint/check";

/** The upstream field names that are none of our params, written by `pnpm provider:prices`. */
const NAMES_FILE = "config/provider/upstream-field-names.json";

/** One catalog file, as far as this check reads it. */
interface CatalogFile {
  models?: Array<{ name?: string; params?: Record<string, unknown> }>;
}

/**
 * Our catalog's params are our names (inner#1743): what each one is sent as on an upstream is that upstream's
 * binding in `config/provider/media/`, so a param named after one upstream's field (`image_urls`, `video_url`)
 * writes that upstream's shape into a catalog every upstream reads.
 *
 * The names come from `config/provider/upstream-field-names.json`, which `pnpm provider:prices` writes: every field
 * a binding sends that is not one of our params. ESLint runs per package and never reads `config/`, so this is the
 * check that sees the yaml.
 */
export const noUpstreamFieldInCatalog = {
  name: "no-upstream-field-in-catalog",
  description: "Catalog params are our own names, never an upstream's field",
  run(context: CheckContext): Finding[] {
    const names = new Set(JSON.parse(context.read(NAMES_FILE)) as string[]);
    const findings: Finding[] = [];
    const catalogs = context.files((path) => /^config\/models\/[^/]+\/models\.yaml$/.test(path), "model catalogs");
    for (const file of catalogs) {
      const catalog = (parseYaml(context.read(file)) ?? {}) as CatalogFile;
      for (const model of catalog.models ?? []) {
        for (const param of Object.keys(model.params ?? {})) {
          if (!names.has(param)) continue;
          findings.push({
            file,
            message:
              `${model.name ?? "?"}.${param} is named as an upstream's field. Name the param ours and map it in each ` +
              `binding's params.`,
          });
        }
      }
    }
    return findings;
  },
} satisfies Check;
