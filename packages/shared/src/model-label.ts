// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A model's name on screen.
 *
 * The catalog names each model by its vendor's name; the mode picker already
 * says which mode it runs in, so the name does not say it again. Where one
 * list holds several versions of one model under the same name (Gemini's text,
 * image and reference endpoints all run the multi-shot mode), each joins on
 * its `variant`, so the reader can tell them apart.
 */

/** The parts of a catalog entry its name is made from. */
export interface NamedModel {
  readonly display_name: string;
  readonly variant?: string;
}

/**
 * A model's name in a list of models offered together.
 * @param model - The model being named.
 * @param peers - Every model in the same list, the model itself included.
 * @returns Its vendor's name, followed by its variant when another model in the list has the same name.
 */
export function modelLabel(model: NamedModel, peers: readonly NamedModel[]): string {
  const shared = peers.some((peer) => peer !== model && peer.display_name === model.display_name);
  return shared && model.variant !== undefined ? `${model.display_name} ${model.variant}` : model.display_name;
}
