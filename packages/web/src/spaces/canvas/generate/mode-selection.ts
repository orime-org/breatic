// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Model and mode resolution shared by every generate panel.
 *
 * The image and video panels are separate components with separate params and
 * separate mode sets (user 2026-08-08), but every question about WHICH model a
 * mode gets is one rule, not one per modality: which models a mode offers,
 * which one to open with, which one to render, and what a mode switch
 * persists. Keeping one implementation of each is what stops the two panels
 * from drifting — they did drift, on the per-mode memory, until #1948.
 */

import type { ModelEntry } from '@breatic/shared';

import type { ParamsStoreSource } from '@web/spaces/canvas/generate/model-params';
import { resolveModelSwitch } from '@web/spaces/canvas/generate/model-params';

/**
 * Keeps only the models offerable under a generation mode — those whose `mode`
 * names it. A multi-mode model (`["t2v", "i2v"]`) belongs to every mode it
 * names.
 *
 * The mode is a plain string here on purpose: each panel owns its own closed
 * mode union and narrows before calling, so this function does not need to
 * know which modality it is serving.
 *
 * A whole modality bucket is a valid input: naming a generation mode is itself
 * the test, so a mini-tool entry in the bucket simply fails to match. Neither
 * panel pre-filters any more — the image one did until #1948, and that pass
 * was provably unable to remove anything this test keeps.
 * @param models - Catalog models to narrow — a whole modality bucket is fine.
 * @param mode - The active generation mode.
 * @returns The models matching the mode, in input order.
 */
export function filterModelsByMode(
  models: ModelEntry[],
  mode: string,
): ModelEntry[] {
  return models.filter((m) =>
    (Array.isArray(m.mode) ? m.mode : [m.mode]).includes(mode),
  );
}

/**
 * Keeps only the modes this deployment can actually serve — those with at
 * least one model (#1951).
 *
 * A deployment configures its own models, so a mode with none is not a
 * capability temporarily out of reach: it is one this deployment does not
 * have, and offering it would show the user something they can never get
 * (user 2026-08-18). That is why the answer is to remove the mode rather
 * than to show it disabled with an explanation — the disabled-with-reason
 * pattern speaks to "you could qualify for this", and nobody here can.
 *
 * The option type is only constrained to carry a `value`, which keeps every
 * caller's own fields — a video option's `slots` and `takesReferences` ride
 * through untouched, and the returned entries are the SAME objects, not
 * copies, so identity-based memoisation upstream still holds.
 * @param options - The modes a panel offers, in display order.
 * @param models - The catalog models for this panel's modality.
 * @returns The subset with at least one model, in input order.
 */
export function filterAvailableModes<T extends { value: string }>(
  options: readonly T[],
  models: ModelEntry[],
): T[] {
  return options.filter((o) => filterModelsByMode(models, o.value).length > 0);
}

/**
 * Picks which model a mode should open with, in priority order (user
 * 2026-07-11): the one the user last chose in that mode if it is still in the
 * catalog, else the first model the mode offers. The `recommended` tier is
 * deliberately NOT consulted — it is a curation BADGE (a mode may carry
 * several recommended models), not a default-selection rule; an earlier
 * resolution misread it as one.
 *
 * Alongside {@link filterModelsByMode} because it is the same kind of rule:
 * one answer to "which model does this mode open with", shared by both panels
 * rather than one copy per modality that can drift on the memory semantics.
 * The mode is a plain string for the same reason — each panel owns its own
 * closed mode union and narrows before calling.
 * @param mode - The active generation mode.
 * @param modelByMode - Per-mode memory of the last-chosen model name.
 * @param filteredModels - The models this mode offers (from {@link filterModelsByMode}).
 * @returns The model name to select, or undefined when the mode offers none.
 */
export function resolveModelForMode(
  mode: string,
  modelByMode: Partial<Record<string, string>>,
  filteredModels: ModelEntry[],
): string | undefined {
  const remembered = modelByMode[mode];
  if (remembered && filteredModels.some((m) => m.name === remembered)) {
    return remembered;
  }
  return filteredModels[0]?.name;
}

/**
 * Picks the model a panel RENDERS for the active mode: the node's stored model
 * when this mode still offers it, else the pick remembered for this mode, else
 * the first model the mode offers (user 2026-07-11 — `recommended` is a
 * curation badge, not a default rule). Empty string when the mode offers none.
 *
 * The middle step is not redundant with the first. The stored model and the
 * active mode can disagree, because the two writes are not symmetric:
 * `setNodeMode` writes both, `setNodeModel` writes only the model. When one
 * collaborator picks a model while another switches mode, the node can end up
 * holding the new mode beside the model picked under the old one — and then
 * what the user should get back is the model THEY chose under this mode, not
 * whichever happens to be listed first.
 * @param stored - The node's stored model id (may be absent / stale / wrong-mode).
 * @param mode - The active generation mode.
 * @param modelByMode - The node's per-mode model memory.
 * @param modeModels - The models offered under the active mode.
 * @returns The model id to render, or empty string when the mode has none.
 */
export function pickModelForMode(
  stored: string | undefined,
  mode: string,
  modelByMode: Record<string, string> | undefined,
  modeModels: ModelEntry[],
): string {
  if (stored && modeModels.some((m) => m.name === stored)) return stored;
  return resolveModelForMode(mode, modelByMode ?? {}, modeModels) ?? '';
}

/** What a node carries into a mode switch: its per-mode memory and its param records. */
export interface ModeSwitchSource extends ParamsStoreSource {
  /** The node's per-mode model memory. */
  modelByMode?: Record<string, string>;
}

/** What a mode switch resolves to — the caller writes both in one transaction. */
export interface ModeSwitchResult {
  /** The model to select, or empty string when the target mode offers none. */
  model: string;
  /** Every per-model record to persist. */
  paramsByModel: Record<string, Record<string, unknown>>;
}

/**
 * Resolves the model and params to persist when a node moves to another
 * generation mode.
 *
 * The outgoing mode's model is deliberately NOT carried over — it belongs to
 * that mode, and the panel would otherwise offer, and submit, a model that
 * cannot do what the mode promises (a text-to-video model ignores a first
 * frame and generates from the prompt alone). The params do not carry over
 * either, for the same reason one step down: the incoming model reads its own
 * record and nothing else (#1948).
 *
 * An empty model means the target mode offers nothing (the catalog is still
 * loading, failed, or genuinely has no entry). The caller must not write that:
 * an empty model with empty records clobbers every model's stored params.
 * @param content - The node's per-mode memory and param records.
 * @param mode - The mode being switched TO.
 * @param models - The catalog models for this panel's modality.
 * @returns The model to select and the records to persist.
 */
export function resolveModeSwitch(
  content: ModeSwitchSource | undefined,
  mode: string,
  models: ModelEntry[],
): ModeSwitchResult {
  const modeModels = filterModelsByMode(models, mode);
  const model =
    resolveModelForMode(mode, content?.modelByMode ?? {}, modeModels) ?? '';
  const picked = modeModels.find((m) => m.name === model);
  if (!picked) return { model, paramsByModel: {} };
  return { model, paramsByModel: resolveModelSwitch(content, picked).paramsByModel };
}
