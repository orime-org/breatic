// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What a proposal card says before the reader presses it (#229, design §5.5).
 *
 * The card has to answer three things in the space of a chat column: what gets
 * built, which model it runs on and what it costs, and what is left for the
 * reader afterwards. All three are read off the proposal, except the price and
 * the wait -- those come from the catalog, because the model does not get to
 * quote its own price.
 */

import type { CanvasProposal, ModelCatalog, ProposalNode } from '@breatic/shared';

/** What one node contributes to the little shape drawn on the card. */
export interface ShapeChip {
  label: string;
  /** True for a node the reader still has to fill in, drawn as an outline. */
  empty: boolean;
}

/** What the card costs and how long it takes, when the catalog knows. */
export interface ProposalPrice {
  /**
   * What one generation costs, when the model charges the same for every one.
   *
   * Absent on a model that charges by what the reader gives it: until they
   * set the duration or write the script there is no per-call price, and the
   * field that looks like one is the balance gate's floor.
   */
  credits?: number;
  seconds: number;
}

/**
 * The node that generates, which is the one the card is about.
 *
 * A proposal without one is refused before a card is ever drawn; reading
 * defensively anyway, because what arrives here was stored on a message and a
 * card built from a bad row must not take the conversation down with it.
 * @param proposal - The proposal the card draws.
 * @returns The first generation node, or undefined.
 * @throws {never} Never.
 */
export function generateNodeOf(proposal: CanvasProposal): ProposalNode | undefined {
  return proposal.nodes.find((n) => n.role === 'generate');
}

/**
 * The chips showing what gets built, left to right as they will be placed.
 * @param proposal - The proposal the card draws.
 * @returns One chip per node.
 * @throws {never} Never.
 */
export function shapeOf(proposal: CanvasProposal): ShapeChip[] {
  return proposal.nodes.map((node) => ({
    label: node.name,
    empty: node.role === 'source',
  }));
}

/**
 * The lines saying what the reader still has to do, in prompt order.
 *
 * One per marked spot, which is what makes them line up with the marks in the
 * prompt itself: the mark says what goes in that place, the line here says
 * what to do about it before pressing.
 * @param proposal - The proposal the card draws.
 * @returns The notes, in the order they appear in the prompt.
 * @throws {never} Never.
 */
export function todosOf(proposal: CanvasProposal): string[] {
  const prompt = generateNodeOf(proposal)?.prompt ?? [];
  return prompt.flatMap((segment) =>
    segment.slot && segment.slot.note !== '' ? [segment.slot.note] : [],
  );
}

/**
 * What this generation costs and how long it takes, from the catalog.
 *
 * The model proposed the model, not its price: a quote it wrote itself would
 * be a guess the reader had no way to check. A model the catalog does not
 * carry gives nothing rather than a zero, and the card simply omits the line
 * -- a price of 0 reads as free.
 * @param catalog - The model catalog, or undefined while it is being fetched.
 * @param model - The model the proposal chose.
 * @returns The price and the wait, or undefined when the catalog has neither.
 * @throws {never} Never.
 */
export function priceOf(
  catalog: ModelCatalog | undefined,
  model: string | undefined,
): ProposalPrice | undefined {
  const entry = entryOf(catalog, model);
  if (!entry) return undefined;
  return {
    ...(entry.rate === undefined ? { credits: entry.cost_per_call } : {}),
    seconds: entry.generation_time,
  };
}

/**
 * The model's catalog row, whichever kind of generation it belongs to.
 * @param catalog - The model catalog, or undefined while it is being fetched.
 * @param model - The model the proposal chose.
 * @returns Its entry, or undefined when the catalog does not carry it.
 * @throws {never} Never.
 */
function entryOf(
  catalog: ModelCatalog | undefined,
  model: string | undefined,
): ModelCatalog['image'][number] | undefined {
  if (!catalog || !model) return undefined;
  for (const bucket of [
    catalog.image,
    catalog.video,
    catalog.audio,
    catalog.tts,
    catalog.three_d,
    catalog.understand,
  ]) {
    const entry = bucket.find((m) => m.name === model);
    if (entry) return entry;
  }
  return undefined;
}

/**
 * What to call the model on the card.
 *
 * The name the picker will put on screen one press later, so the reader is
 * not left matching an id against the words in front of them. Until the
 * catalog lands, and for a model it does not carry, the id stands in -- the
 * note beside it is written about a particular model and needs one named.
 * @param catalog - The model catalog, or undefined while it is being fetched.
 * @param model - The model the proposal chose.
 * @returns The name to show, or undefined when the proposal names no model.
 * @throws {never} Never.
 */
export function nameOf(
  catalog: ModelCatalog | undefined,
  model: string | undefined,
): string | undefined {
  return entryOf(catalog, model)?.display_name || model;
}
