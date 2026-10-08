// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What each mode is called and what it is for (#269).
 *
 * The material a run needs is declared on each model (#2156), not here: two
 * models in one mode can take different sources.
 *
 * Nothing here degrades to a default the way the wire schemas do: it is read
 * while the catalog loads, on the machine that ships both, where a malformed
 * mode is better refused than guessed at.
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

/** One mode, as `config/models/modes.yaml` declares it. */
export interface ModeDeclaration {
  /** The product's name for it, as the picker shows it. */
  readonly label: string;
  /** What it does, for the agent to read. */
  readonly description: string;
}

/** One catalog bucket's declarations. */
export interface BucketDeclaration {
  /** Its modes, by mode code. */
  readonly modes: Readonly<Record<string, ModeDeclaration>>;
}

/** Every declared mode, by catalog bucket. */
export type ModeConfig = Readonly<Record<string, BucketDeclaration>>;

// Strict: the key set is closed, so a misspelled key is refused rather than
// dropped in silence.
const modeSchema = z.strictObject({
  label: z.string().min(1),
  description: z.string().default(""),
});

const bucketSchema = z.strictObject({
  modes: z.record(z.string(), modeSchema).default({}),
});

const configSchema = z.record(z.string(), bucketSchema);

/**
 * Read the parsed `modes.yaml` into declarations, refusing a malformed one.
 * @param raw - The yaml as parsed, before any shape is assumed of it.
 * @returns Every mode it declares, by bucket then mode code.
 * @throws {Error} when a mode has no label or carries a key a mode does not have.
 */
export function parseModeConfig(raw: unknown): ModeConfig {
  const parsed = configSchema.safeParse(raw ?? {});
  if (!parsed.success) throw new Error(faultLine(parsed.error, raw));

  const config: Record<string, BucketDeclaration> = {};
  for (const [bucket, { modes }] of Object.entries(parsed.data)) {
    config[bucket] = {
      modes: Object.fromEntries(
        Object.entries(modes).map(([mode, row]) => [
          mode,
          {
            label: row.label,
            description: row.description,
          },
        ]),
      ),
    };
  }
  return config;
}

let cache: ModeConfig | null = null;

/**
 * The declarations in `config/models/modes.yaml`, read once per process.
 * @returns Every mode it declares, by bucket then mode code.
 * @throws {Error} when a mode has no label or carries a key a mode does not have.
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
  readonly mode?: string | readonly string[];
}


/** Anything that names modes the way a catalog entry does. */
export interface ModeNamer {
  /** A single mode code, or several when one entry serves more than one. */
  readonly mode?: string | readonly string[];
}

/**
 * The modes one entry names, with "saying nothing" kept as one empty name.
 *
 * `mode` is one code, several, or — when the field is missing or holds an
 * empty list — none. All three of the last shape have to reach the reader as
 * something rather than as no rows at all: a walk over zero modes agrees with
 * anything, and the enqueue gates then treat a model with no modes as one they
 * have no business guarding.
 * @param entry - The entry to read.
 * @returns Its mode codes, or a single empty string when it names none.
 */
export function namedModes(entry: ModeNamer): string[] {
  const named = [entry.mode ?? ""].flat();
  return named.length === 0 ? [""] : named;
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
  const declared = config[bucket]?.modes ?? {};
  const offenders = models.flatMap((model) =>
    namedModes(model)
      .filter((mode) => mode === "" || !(mode in declared))
      .map((mode) => `${model.name} (${mode === "" ? "no mode declared" : mode})`),
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
