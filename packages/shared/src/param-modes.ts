// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Which of a model's params apply in a mode. A param naming `modes` applies in
 * those alone; the panel draws its control and the run sends its value by this
 * one rule, so the two cannot disagree.
 */

import type { ParamDescriptor } from "@shared/types/model-catalog.js";

/**
 * Whether a declared param applies in a mode.
 * @param spec - The param's declaration.
 * @param mode - The mode.
 * @returns True when it names no modes or names this one.
 */
export function appliesInMode(spec: Pick<ParamDescriptor, "modes">, mode: string): boolean {
  return spec.modes === undefined || spec.modes.includes(mode);
}

/**
 * The stored params a run in this mode keeps: params are stored per model, so
 * one set in another mode is still in the record and is dropped here.
 * @param params - The params stored for the model.
 * @param declared - The model's params.
 * @param mode - The mode the run is in.
 * @returns The params without those declared only for other modes.
 */
export function paramsForMode(
  params: Readonly<Record<string, unknown>>,
  declared: Readonly<Record<string, ParamDescriptor>>,
  mode: string,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(params).filter(([name]) => {
      const spec = declared[name];
      return spec === undefined || appliesInMode(spec, mode);
    }),
  );
}
