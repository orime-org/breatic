// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Which sources a run still needs, read off the model's own declarations.
 *
 * One rule for the generate panel, the server's pre-enqueue gate and the
 * agent's proposal check: a slot or pool the model does not mark optional has
 * to hold something, and each "one of these" group the model declares for the
 * mode has to have one member holding something.
 */

import type { SourceGroup } from "@shared/types/model-catalog.js";

/** What the check reads off one declared param. */
export interface SourceSlot {
  readonly fill?: string;
  readonly optional?: boolean;
  readonly modes?: readonly string[];
  readonly type?: string;
}

/** What the check reads off one model. */
export interface SourcedModel {
  readonly params: Readonly<Record<string, SourceSlot>>;
  readonly source_groups?: readonly SourceGroup[];
}

/** One unmet requirement: any one of these params would meet it. */
export type MissingSource = readonly string[];

/**
 * Whether a value carries anything to send: nothing, an empty string and an
 * empty list do not; every other value does, `0` and `false` included.
 *
 * The one answer to this, read by the price estimate, the worker's request
 * body and the source check below, so the three cannot part on it.
 * @param value - A param's value.
 * @returns False for nothing, an empty string and an empty list.
 */
export function holds(value: unknown): boolean {
  if (value === undefined || value === null || value === "") return false;
  return !Array.isArray(value) || value.length > 0;
}

/**
 * Whether a param holds a source the run can send.
 *
 * The params arrive untyped on the wire, so the shape is checked against the
 * declaration: a list holds at least one non-empty address, a list editor at
 * least one entry, and any other slot a non-empty address.
 * @param slot - The param's declaration.
 * @param value - What the submission put there.
 * @returns True when it carries something usable.
 */
function holdsSource(slot: SourceSlot, value: unknown): boolean {
  if (!holds(value)) return false;
  if (slot.type === "items") return Array.isArray(value) && value.length > 0;
  if (slot.type === "list") {
    return Array.isArray(value) && value.some((entry) => typeof entry === "string" && entry.length > 0);
  }
  return typeof value === "string" && value.length > 0;
}

/**
 * The sources a run in one mode still needs.
 * @param model - The model's declarations.
 * @param mode - The mode the run is in.
 * @param params - The run's params, keyed by the catalog's names.
 * @returns Each unmet requirement, required slots first in declaration order,
 *   then groups; empty when the run has what it needs.
 */
export function missingSources(
  model: SourcedModel,
  mode: string,
  params: Readonly<Record<string, unknown>>,
): MissingSource[] {
  const missing: MissingSource[] = [];
  for (const [name, slot] of Object.entries(model.params)) {
    if (slot.fill !== "canvas" && slot.fill !== "pool") continue;
    if (slot.optional === true) continue;
    if (slot.modes !== undefined && !slot.modes.includes(mode)) continue;
    if (!holdsSource(slot, params[name])) missing.push([name]);
  }
  for (const group of model.source_groups ?? []) {
    if (group.mode !== mode) continue;
    const met = group.any_of.some((name) => {
      const slot = model.params[name];
      return slot !== undefined && holdsSource(slot, params[name]);
    });
    if (!met) missing.push(group.any_of);
  }
  return missing;
}

/**
 * Whether a submission makes a valid run of any of a model's modes.
 *
 * For a caller that holds the params but not the mode they were set up in:
 * the server receives a model and its params, and one endpoint serves every
 * mode the model lists.
 * @param model - The model's declarations.
 * @param modes - The modes the model serves.
 * @param params - The submitted params.
 * @returns True when some mode has everything it needs.
 */
export function fitsSomeMode(
  model: SourcedModel,
  modes: readonly string[],
  params: Readonly<Record<string, unknown>>,
): boolean {
  return modes.some((mode) => missingSources(model, mode, params).length === 0);
}
