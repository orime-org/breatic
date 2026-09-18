// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Cross-modality execute-gate rule (#1675). THE single source of truth for
 * "which source inputs does a generation mode require". Lives in domain
 * (backend-only); the frontend never runs this — the catalog projection
 * ships the computed `ModelEntry.sourcesByMode` on the wire and the
 * Generate panel reads that. The server calls `violatesSourceRequirement`
 * directly (it can import domain), applying the SAME rule to the submitted
 * params. One rule, two consumers (frontend via wire, server via call),
 * differing only in the runtime data each checks (references vs params).
 *
 * `edit` / `upscale` need different source types per modality (image-edit
 * needs an image, video-edit needs a video), so the mode→source map is keyed
 * by (modality, mode), not mode alone.
 */

import type { SourceRule, SourceType } from "@breatic/shared";

import { getModeConfig } from "@domain/model-catalog/mode-config.js";


/** What the gate reads off one of a model's parameter declarations. */
export interface CarrierDeclaration {
  /** The kind of node this param takes, when it takes one. */
  accepts?: string;
  /**
   * Whether a run may go without it.
   *
   * A run that goes without this one is a run with no source in it, so an
   * optional carrier cannot be the thing that meets a requirement: the style
   * reference an image edit may add takes a picture and is not the picture
   * being edited.
   */
  optional?: boolean;
  /**
   * The wire shape it travels in.
   *
   * The worker reads a `"list"` param as an array and every other as one URL
   * string, so the gate mirrors that: a bare string in a list param is a
   * guaranteed-failure input, not a source.
   */
  type?: "list";
}

/**
 * Required source types for one (modality, mode).
 *
 * Read off `config/models/modes.yaml`, which is indexed by mode rather than by
 * model: one row says what a first-and-last-frame run needs, and every model
 * offering that mode is held to it. A mode with no row declares nothing, and
 * the catalog refuses to load a model naming one.
 * @param modality - Model modality (e.g. "image", "video").
 * @param mode - A single mode string.
 * @returns The source types that mode needs; empty when it needs none.
 */
function sourcesForMode(modality: string, mode: string): readonly SourceType[] {
  return getModeConfig()[modality]?.[mode]?.sources ?? [];
}

/**
 * Compute the wire `ModelEntry.sourcesByMode`: each of a model's modes →
 * the source types it requires. Called by the catalog projection so the
 * frontend can read `sourcesByMode[activeMode]` without running any rule.
 * @param modality - The model's modality.
 * @param mode - The model's `mode` (a single string or an array of modes).
 * @returns A map from each mode to its required source types.
 */
export function computeSourcesByMode(
  modality: string,
  mode: string | string[],
): Record<string, SourceType[]> {
  const modes = Array.isArray(mode) ? mode : [mode];
  const out: Record<string, SourceType[]> = {};
  for (const m of modes) {
    out[m] = [...sourcesForMode(modality, m)];
  }
  return out;
}

/**
 * Compute the wire `ModelEntry.sourceRuleByMode`: each of a model's modes →
 * whether it takes every slot it offers or any one of them.
 *
 * Beside {@link computeSourcesByMode} rather than folded into it because the
 * two answer different questions: that one says which kinds a run needs, this
 * one how many of the slots carrying them have to be filled. `a2m` needs one
 * audio source and offers three slots, so the types alone would demand three.
 * @param modality - The model's modality.
 * @param mode - The model's `mode` (a single string or an array of modes).
 * @returns A map from each mode to its rule; `all_of` where none is declared.
 */
export function computeSourceRuleByMode(
  modality: string,
  mode: string | string[],
): Record<string, SourceRule> {
  const config = getModeConfig();
  const out: Record<string, SourceRule> = {};
  for (const m of Array.isArray(mode) ? mode : [mode]) {
    out[m] = config[modality]?.[m]?.sourceRule ?? "all_of";
  }
  return out;
}

/**
 * Whether a source of `type` is present in a submitted params payload, checking
 * each carrier param by the shape it declares.
 *
 * `params` is `z.record(z.unknown())` on the wire (zod does not shape-check
 * it), so this guards against a crafted request putting the wrong shape in a
 * source field: a param declared `type: "list"` counts only as a non-empty
 * array with at least one non-empty string URL, and any other counts only as a
 * non-empty string.
 *
 * Which of a model's params can carry which kind is the model's own `accepts`,
 * so one model reading another vendor's spelling is not a source it can use:
 * the transport builds its request from the params the model declares, so an
 * undeclared field reaches the upstream as nothing (#1960). A param the run
 * may go without carries nothing this asks about.
 * @param type - The source type to look for.
 * @param params - The submitted task params.
 * @param declared - What the model declares about each of its params.
 * @returns True when the params carry at least one usable source of that type.
 */
function hasSource(
  type: SourceType,
  params: Record<string, unknown>,
  declared: Readonly<Record<string, CarrierDeclaration>>,
): boolean {
  for (const [field, spec] of Object.entries(declared)) {
    if (spec?.accepts !== type || spec.optional === true) continue;
    const value = params[field];
    const present =
      spec.type === "list"
        ? Array.isArray(value) &&
          value.some((entry) => typeof entry === "string" && entry.length > 0)
        : typeof value === "string" && value.length > 0;
    if (present) return true;
  }
  return false;
}

/**
 * Server-side execute gate (#1675): does this model's per-mode source
 * requirement go unmet by the submitted params?
 *
 * A model that can run source-less (ANY mode needs no source — e.g. a HYBRID
 * `["t2i","i2i"]`, or any t2i/t2v/…) is NOT gated: an image-less submission is
 * a valid text-to-X run. Only a model whose EVERY mode needs a source is
 * gated, and then every required source type (across its modes) must be present
 * in params. Applied by the server BEFORE enqueue so no task row / job is
 * created for an input the model would reject. (Not a billing guard: billing is
 * post-success, so a source-less run that reached the worker would fail and
 * never bill anyway — the gate saves the doomed attempt, not the credits.) The
 * SAME `sourcesByMode` the frontend reads drives this — one rule, checked here
 * against params.
 * @param sourcesByMode - The model's per-mode source requirements ({@link computeSourcesByMode}); the catalog carries it precomputed.
 * @param params - The submitted task params (`params.images` / `video_url` / … are the source carriers).
 * @param declared - What the model declares about each of its params, so a
 *   field belonging to another vendor's spelling cannot satisfy this model's
 *   requirement (#1960).
 * @returns True when a required source type is missing → reject before enqueue.
 */
export function violatesSourceRequirement(
  sourcesByMode: Record<string, SourceType[]>,
  params: Record<string, unknown>,
  declared: Readonly<Record<string, CarrierDeclaration>>,
): boolean {
  const modes = Object.values(sourcesByMode);
  if (modes.length === 0) return false; // unknown model — existence is not this gate's job
  // Source-less escape hatch: any mode needing no source means the model can
  // run from scratch (t2i-like / hybrid), so an empty-source submission is valid.
  if (modes.some((sources) => sources.length === 0)) return false;
  // Every mode needs a source → require each source type any mode demands.
  const required = new Set<SourceType>(modes.flat());
  for (const type of required) {
    if (!hasSource(type, params, declared)) return true;
  }
  return false;
}
