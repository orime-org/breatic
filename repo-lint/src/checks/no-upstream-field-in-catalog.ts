// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0
import { parse as parseYaml } from "yaml";
import type { Check, CheckContext, Finding } from "#repo-lint/check";

/** One catalog file, as far as this check reads it. */
interface CatalogFile {
  models?: Array<{ name?: string; params?: Record<string, unknown> }>;
}

/** How a binding writes one of our params, as far as this check reads it. */
interface BoundParam {
  field?: string;
  item_fields?: Record<string, { field?: string }>;
}

/** One provider media file, as far as this check reads it. */
interface MediaFile {
  models?: Record<string, { upstreams?: Array<{ params?: Record<string, BoundParam> }> }>;
}

/**
 * Catalog params whose name a binding happens to send another of our params as, each with why the name is ours. A
 * name is excused only here, by review, so a catalog cannot make a field name ours by using it.
 */
const EXCUSED: ReadonlyMap<string, string> = new Map([
  ["audio", "the source audio a lipsync or talking-avatar model speaks; fal's Wan sends generate_audio as its own `audio` switch"],
  ["shot_type", "Kling's shot setting as WaveSpeed names it, the blueprint the catalog keeps (inner#1743)"],
  ["reference_images", "Wan video edit's reference images as WaveSpeed names them, the blueprint the catalog keeps (inner#1743)"],
  ["reference_audios", "Wan video edit's reference audio as WaveSpeed names it, the blueprint the catalog keeps (inner#1743)"],
]);

/**
 * Every name a binding sends one of our params, or an item field of one, as when it is not that param's own name;
 * each part of a dotted field counts.
 * @param context - The check context.
 * @returns The names.
 */
function upstreamFieldNames(context: CheckContext): Set<string> {
  const names = new Set<string>();
  /**
   * Add the parts of a field our name is sent as, other than our name.
   * @param ours - Our name.
   * @param field - The field, dotted for a nested one.
   */
  const add = (ours: string, field: string | undefined): void => {
    for (const part of field?.split(".") ?? []) if (part !== ours) names.add(part);
  };
  const media = context.files((path) => /^config\/provider\/media\/[^/]+\.yaml$/.test(path), "provider media bindings");
  for (const file of media) {
    const doc = (parseYaml(context.read(file)) ?? {}) as MediaFile;
    for (const model of Object.values(doc.models ?? {})) {
      for (const binding of model.upstreams ?? []) {
        for (const [param, bound] of Object.entries(binding.params ?? {})) {
          add(param, bound.field);
          for (const [item, sub] of Object.entries(bound.item_fields ?? {})) add(item, sub.field);
        }
      }
    }
  }
  return names;
}

/**
 * Our catalog's params are our names (inner#1743): what each one is sent as on an upstream is that upstream's
 * binding in `config/provider/media/`, so a param named after one upstream's field (`image_urls`, `video_url`)
 * writes that upstream's shape into a catalog every upstream reads.
 *
 * The names are read off the bindings alone: every field a binding sends one of our params as that is not the
 * param's own name, less the names {@link EXCUSED} reviews as ours. ESLint lints source files one package at a time and
 * never lints the catalog or binding yaml, so this is the check that sees it.
 */
export const noUpstreamFieldInCatalog = {
  name: "no-upstream-field-in-catalog",
  description: "Catalog params are our own names, never an upstream's field",
  run(context: CheckContext): Finding[] {
    const names = upstreamFieldNames(context);
    const findings: Finding[] = [];
    const catalogs = context.files((path) => /^config\/models\/[^/]+\/models\.yaml$/.test(path), "model catalogs");
    for (const file of catalogs) {
      const catalog = (parseYaml(context.read(file)) ?? {}) as CatalogFile;
      for (const model of catalog.models ?? []) {
        for (const param of Object.keys(model.params ?? {})) {
          if (!names.has(param) || EXCUSED.has(param)) continue;
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
