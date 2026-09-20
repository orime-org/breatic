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

/**
 * One step of a flow: the nodes that are ready at the same moment.
 *
 * Drawn side by side, with an arrow between one layer and the next. Nodes of
 * one layer never feed each other -- three angles off one photo are three
 * things the reader gets, not a chain of three.
 */
export type ShapeLayer = ShapeChip[];

/**
 * One run of the flow, from what it starts with to what it makes.
 *
 * Groups are drawn apart, with no arrow between them: a written note wired to
 * nothing is its own run, and an arrow into the picture beside it would say
 * the copy was the prompt for it -- which is the one thing the proposal
 * deliberately did not say.
 */
export type ShapeGroup = ShapeLayer[];

/** What one node still asks of the reader, under the node's own name. */
export interface NodeTodos {
  node: string;
  notes: string[];
}

/** What the card costs and how long it takes, when the catalog knows. */
export interface ProposalPrice {
  /**
   * What the whole press costs, when every model charges the same per run.
   *
   * Absent when any of them charges by what the reader gives it: until they
   * set the duration or write the script there is no per-call price, and the
   * field that looks like one is the balance gate's floor.
   */
  credits?: number;
  /** The longest of the runs, since one press starts them all at once. */
  seconds: number;
  /** How many generations one press starts. */
  runs: number;
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
export function shapeOf(proposal: CanvasProposal): ShapeGroup[] {
  return [[proposal.nodes.map((node) => ({ label: node.name, empty: node.role === 'source' }))]];
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
export function todosOf(proposal: CanvasProposal): NodeTodos[] {
  return proposal.nodes.length === 0 ? [] : [];
}

/**
 * What this generation costs and how long it takes, from the catalog.
 *
 * The model proposed the model, not its price: a quote it wrote itself would
 * be a guess the reader had no way to check. A model the catalog does not
 * carry gives nothing rather than a zero, and the card simply omits the line
 * -- a price of 0 reads as free.
 * @param catalog - The model catalog, or undefined while it is being fetched.
 * @param proposal - The proposal the card draws.
 * @returns The price and the wait, or undefined when the catalog cannot say.
 * @throws {never} Never.
 */
export function costOf(
  catalog: ModelCatalog | undefined,
  proposal: CanvasProposal,
): ProposalPrice | undefined {
  return catalog && proposal.nodes.length === 0 ? undefined : undefined;
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
