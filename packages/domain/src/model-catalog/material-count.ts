// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * How many pieces of material a run asks its reader for (#269).
 */

import { z } from "zod";

import type { ModeDeclaration } from "@domain/model-catalog/mode-config.js";
import type { ParamClaimant } from "@domain/model-catalog/param-declaration.js";

/** The fields of a declaration this count reads. */
const slotSchema = z.object({
  fill: z.string().optional(),
  optional: z.boolean().optional(),
  modes: z.array(z.string()).optional(),
  accepts: z.string().optional(),
});

/** What one model offers a reader in one mode, before the mode's own rule. */
interface MaterialShape {
  /** How many slots it offers for each kind, keyed by the kind they take. */
  byKind: Map<string, number>;
  /** Whether it also draws on the reference pool. */
  pool: boolean;
  /** Whether every slot it offers says which kind it takes. */
  kindsKnown: boolean;
}

/**
 * The slots one model offers in one mode, read off its declarations once.
 *
 * One walk with two named readings above it, because the two want different
 * things out of it: how many pieces in all, and how many of each kind. Walked
 * twice, the two answers are free to disagree about the same model.
 * @param model - The model, with its parameter declarations.
 * @param mode - The mode being asked about.
 * @returns What it offers, by kind and in all.
 * @throws {never} Never.
 */
function slotsOffered(model: ParamClaimant, mode: string): MaterialShape {
  const byKind = new Map<string, number>();
  let pool = false;
  let kindsKnown = true;
  for (const raw of Object.values(model.params ?? {})) {
    const spec = slotSchema.safeParse(raw);
    if (!spec.success) continue;
    const { fill, optional, modes, accepts } = spec.data;
    if (modes !== undefined && !modes.includes(mode)) continue;
    // A pool holds as many as the reader wires into it, and that it holds at
    // least one is the one piece counted here.
    if (fill === "pool") pool = true;
    if (fill !== "canvas" || optional === true) continue;
    if (accepts === undefined) kindsKnown = false;
    else byKind.set(accepts, (byKind.get(accepts) ?? 0) + 1);
  }
  return { byKind, pool, kindsKnown };
}

/**
 * The pieces of material one model in one mode asks a reader to supply.
 * @param model - The model, with its parameter declarations.
 * @param mode - The mode being asked about.
 * @param declared - What the mode declares, when it is declared at all.
 * @returns How many separate pieces the reader has to point at.
 * @throws {never} Never.
 */
export function materialCount(
  model: ParamClaimant,
  mode: string,
  declared: ModeDeclaration | undefined,
): number {
  // The mode says one of its slots is enough; which one is the reader's to
  // pick, so the count is one however many the model offers.
  if (declared?.sourceRule === "any_of") return 1;

  const offered = slotsOffered(model, mode);
  const slots = [...offered.byKind.values()].reduce((sum, n) => sum + n, 0);
  return slots + (offered.pool ? 1 : 0);
}

/**
 * The same pieces, split by the kind of material each one takes.
 *
 * Beside {@link materialCount} because a total cannot answer what the reader
 * is still holding: two tracks arriving from the step before say nothing about
 * the portrait, and subtracted from one total they cover it.
 *
 * Two shapes have no per-kind answer and both say so by returning nothing
 * rather than a map that reads as complete. A mode taking any one of its slots
 * leaves the choice of kind to the reader, and a slot declaring no kind is one
 * this cannot place -- counted as zero of something, it would say the reader
 * has less to supply than they do.
 * @param model - The model, with its parameter declarations.
 * @param mode - The mode being asked about.
 * @param declared - What the mode declares, when it is declared at all.
 * @returns Pieces per kind, or undefined where the split does not exist.
 * @throws {never} Never.
 */
export function materialByKind(
  model: ParamClaimant,
  mode: string,
  declared: ModeDeclaration | undefined,
): Map<string, number> | undefined {
  if (declared?.sourceRule === "any_of") return undefined;
  const offered = slotsOffered(model, mode);
  if (!offered.kindsKnown) return undefined;
  // The pool is not in this map and cannot be: it holds as many as the reader
  // wires in, of whatever the pool carries, so it has no per-kind number. A
  // model reading one takes its material by that path and is counted there.
  return offered.byKind;
}
