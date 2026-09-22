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
});

/**
 * The pieces of material one model in one mode asks a reader to supply.
 * @param model - The model, with its parameter declarations.
 * @param mode - The mode being asked about.
 * @param declared - What the mode declares, when it is declared at all.
 * @returns How many separate pieces the reader has to point at.
 */
export function materialCount(
  model: ParamClaimant,
  mode: string,
  declared: ModeDeclaration | undefined,
): number {
  // The mode says one of its slots is enough; which one is the reader's to
  // pick, so the count is one however many the model offers.
  if (declared?.sourceRule === "any_of") return 1;

  let slots = 0;
  let pool = false;
  for (const raw of Object.values(model.params ?? {})) {
    const spec = slotSchema.safeParse(raw);
    if (!spec.success) continue;
    const { fill, optional, modes } = spec.data;
    if (modes !== undefined && !modes.includes(mode)) continue;
    // A pool holds as many as the reader wires into it, and that it holds at
    // least one is the one piece counted here.
    if (fill === "pool") pool = true;
    if (fill === "canvas" && optional !== true) slots += 1;
  }
  return slots + (pool ? 1 : 0);
}
