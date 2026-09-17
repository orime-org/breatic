// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What each mode declares about the material it needs (#269).
 *
 * The source requirement is indexed by mode, not by model: one row says what
 * a first-and-last-frame run needs, and every model offering that mode is
 * held to it. Derived from each model's parameters instead, it would reach
 * only the models a generation panel reaches -- ten short of the models the
 * enqueue gate guards.
 *
 * Nothing here degrades to a default the way the wire schemas do. Those are
 * read by a browser that may be a version behind the catalog, so a field it
 * does not recognise is better absent than guessed; this one is read while
 * the catalog loads, on the machine that ships both, where a mode naming a
 * source type nothing can carry is a deployment that will refuse runs it
 * should accept. Loud on the way in beats quiet at request time.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { MONOREPO_ROOT } from "@breatic/core";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

const MODES_CONFIG_PATH = resolve(MONOREPO_ROOT, "config/models/modes.yaml");

/** The kinds of node a mode can ask a reader for. */
export const SOURCE_TYPES = ["image", "video", "audio"] as const;

/** One kind of node a mode can ask a reader for. */
export type SourceType = (typeof SOURCE_TYPES)[number];

/** How many of a mode's slots have to hold something. */
export const SOURCE_RULES = ["all_of", "any_of"] as const;

/** Whether a mode takes every slot it offers or any one of them. */
export type SourceRule = (typeof SOURCE_RULES)[number];

/** One mode, as `config/models/modes.yaml` declares it. */
export interface ModeDeclaration {
  /** The product's name for it, as the picker shows it. */
  readonly label: string;
  /** What it does, for the agent to read. */
  readonly description: string;
  /** The kinds of node it needs; empty when it runs from words alone. */
  readonly sources: readonly SourceType[];
  /** Whether it takes every non-optional slot or any one of them. */
  readonly sourceRule: SourceRule;
}

/** Every declared mode, by catalog bucket and then by mode code. */
export type ModeConfig = Readonly<Record<string, Readonly<Record<string, ModeDeclaration>>>>;

/**
 * One mode's row.
 *
 * `source_rule` quantifies over the mode's canvas slots, not over `sources`:
 * `a2m` needs one audio source and offers three slots to carry it, so a rule
 * read against the one-element `sources` list would answer the same either
 * way and say nothing.
 */
const modeSchema = z.object({
  label: z.string().min(1),
  description: z.string().default(""),
  sources: z.array(z.enum(SOURCE_TYPES)).default([]),
  source_rule: z.enum(SOURCE_RULES).default("all_of"),
});

const bucketSchema = z.object({ modes: z.record(z.string(), modeSchema).default({}) });

const configSchema = z.record(z.string(), bucketSchema);

/**
 * Read the parsed `modes.yaml` into declarations, refusing a malformed one.
 * @param raw - The yaml as parsed, before any shape is assumed of it.
 * @returns Every mode it declares, by bucket then mode code.
 * @throws {Error} when a mode names an unknown source type or rule, or has no label.
 */
export function parseModeConfig(raw: unknown): ModeConfig {
  const parsed = configSchema.safeParse(raw ?? {});
  if (!parsed.success) throw new Error(faultLine(parsed.error, raw));

  const config: Record<string, Record<string, ModeDeclaration>> = {};
  for (const [bucket, { modes }] of Object.entries(parsed.data)) {
    config[bucket] = Object.fromEntries(
      Object.entries(modes).map(([mode, row]) => [
        mode,
        {
          label: row.label,
          description: row.description,
          sources: row.sources,
          sourceRule: row.source_rule,
        },
      ]),
    );
  }
  return config;
}

let cache: ModeConfig | null = null;

/**
 * The declarations in `config/models/modes.yaml`, read once per process.
 * @returns Every mode it declares, by bucket then mode code.
 * @throws {Error} when a mode names an unknown source type or rule, or has no label.
 */
export function getModeConfig(): ModeConfig {
  if (cache) return cache;
  // An empty or comment-only file parses to null, which the schema would then
  // be handed in place of an object.
  const raw = existsSync(MODES_CONFIG_PATH)
    ? (parseYaml(readFileSync(MODES_CONFIG_PATH, "utf-8")) ?? {})
    : {};
  cache = parseModeConfig(raw);
  return cache;
}

/**
 * Drop the cached declarations so the next read goes back to the file.
 *
 * The catalog has a reset of its own and the two are read together, so a test
 * swapping one while the other answers from a previous file would be holding
 * the models of one catalog to the modes of another.
 */
export function resetModeConfig(): void {
  cache = null;
}

/** One catalog entry, reduced to the part this check reads. */
export interface ModeClaimant {
  /** The model's name, so a fault can say whose mode it is. */
  readonly name: string;
  /** A single mode code, or several when one model serves more than one. */
  readonly mode: string | readonly string[];
}

/**
 * Hold a bucket's models to the modes the config declares.
 *
 * A model naming a mode no row describes is a mode with no source rule and no
 * label, and every answer about it -- what it needs, what to call it, whether
 * a submission missing its material should be refused -- falls back to a
 * default that says the run is fine. The catalog refuses to load instead.
 * @param bucket - The catalog bucket these models came from.
 * @param models - Its models, each naming the modes it serves.
 * @param config - The declarations to hold them to.
 * @throws {Error} when any model names a mode the config does not declare.
 */
export function assertModesDeclared(
  bucket: string,
  models: readonly ModeClaimant[],
  config: ModeConfig,
): void {
  const declared = config[bucket] ?? {};
  const offenders = models.flatMap((model) =>
    (Array.isArray(model.mode) ? model.mode : [model.mode])
      .filter((mode) => mode !== "" && !(mode in declared))
      .map((mode) => `${model.name} (${mode})`),
  );
  if (offenders.length === 0) return;
  throw new Error(
    `config/models/${bucket}: every model's mode must be declared in modes.yaml; ` +
      `undeclared on: ${offenders.join(", ")}`,
  );
}

/**
 * Every fault in one sentence, each naming the mode it is on and the value.
 *
 * Zod's own path is `["video", "modes", "i2v", "sources", 0]`, which reads as
 * the shape rather than as the thing a person edits, and its message for a
 * rejected option lists what was allowed without saying what arrived. Both
 * halves are what the person fixing it needs: the mode code is what they
 * will search the yaml for, and the value is what they will search for in it.
 * @param error - What the schema refused.
 * @param raw - The input it refused, to read the offending values back out of.
 * @returns One line naming every offending mode, value and reason.
 */
function faultLine(error: z.ZodError, raw: unknown): string {
  const faults = error.issues.map((issue) => {
    const [bucket, , mode, field] = issue.path;
    const at = [bucket, mode].filter((part) => part !== undefined).join(".");
    const on = field === undefined ? "" : ` (${String(field)})`;
    const got = valueAt(raw, issue.path);
    const saw = got === undefined ? "" : ` — got ${JSON.stringify(got)}`;
    return `${at}${on}: ${issue.message}${saw}`;
  });
  return `config/models/modes.yaml declares modes it cannot answer for — ${faults.join("; ")}`;
}

/**
 * The value an issue's path points at, for quoting it back.
 * @param raw - The refused input.
 * @param path - The issue's path into it.
 * @returns The value there, or undefined when the path does not reach one.
 */
function valueAt(raw: unknown, path: readonly PropertyKey[]): unknown {
  let here: unknown = raw;
  for (const step of path) {
    if (here === null || typeof here !== "object") return undefined;
    here = (here as Record<PropertyKey, unknown>)[step];
  }
  return here;
}
