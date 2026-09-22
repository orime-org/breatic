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

import { layersOf, nameableFeeders } from '@breatic/shared';
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

/**
 * What some nodes still ask of the reader, under their own names.
 *
 * More than one name when several nodes ask for the same thing in the same
 * words: three angles each wanting a ratio picked is one line of instruction,
 * and written per node it reads as three separate jobs.
 */
export interface NodeTodos {
  nodes: string[];
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
  /** The longest of the runs. */
  seconds: number;
  /** How many generations the placed group will run. */
  runs: number;
  /**
   * Whether every run takes the same time, which is what "each" needs.
   *
   * A picture at 25 seconds beside a video at 180 drawn as "180 s x 2" says
   * the picture takes three minutes. Where the runs differ there is no per-run
   * number to multiply, and the card draws the longest on its own.
   */
  sameLength: boolean;
}

/**
 * The nodes already holding their words, in the order they were proposed.
 *
 * The card draws them out in full. The words are in hand before anything is
 * placed, and a reader who wants another version says so in the chat -- with a
 * title alone they would have to place the node, read it, and then undo
 * something they never wanted.
 *
 * A generation has no counterpart here: what it makes does not exist yet, so
 * there is nothing to draw. The difference is not a preference about cards.
 * @param proposal - The proposal the card draws.
 * @returns Every node carrying finished words.
 * @throws {never} Never.
 */
export function writtenOf(proposal: CanvasProposal): ProposalNode[] {
  return proposal.nodes.filter((n) => n.role === 'written');
}

/**
 * The one model this flow runs on, when it runs on one.
 *
 * The note beside the name is a single top-level field describing a single
 * model (`inputSchema`). Three generations on three models leave it saying
 * something about no one of them, so the line is not drawn at all.
 * @param proposal - The proposal the card draws.
 * @returns The model every generation uses, or undefined when they differ.
 * @throws {never} Never.
 */
export function modelOf(proposal: CanvasProposal): string | undefined {
  const models = new Set(
    proposal.nodes.flatMap((n) => (n.role === 'generate' && n.model ? [n.model] : [])),
  );
  return models.size === 1 ? [...models][0] : undefined;
}

/**
 * The chips showing what gets built, left to right as they will be placed.
 * @param proposal - The proposal the card draws.
 * @returns One chip per node.
 * @throws {never} Never.
 */
export function shapeOf(proposal: CanvasProposal): ShapeGroup[] {
  const layer = layersOf(proposal);
  const run = runsOf(proposal);
  const groups = new Map<number, Map<number, ShapeChip[]>>();
  proposal.nodes.forEach((node, at) => {
    const chip = { label: node.name, empty: node.role === 'source' };
    const depth = layer[at] ?? 0;
    const home = groups.get(run[at] ?? at) ?? new Map<number, ShapeChip[]>();
    home.set(depth, [...(home.get(depth) ?? []), chip]);
    groups.set(run[at] ?? at, home);
  });
  return [...groups.values()].map((layers) =>
    [...layers.keys()].sort((a, b) => a - b).map((depth) => layers.get(depth) ?? []),
  );
}

/**
 * Which run of the flow each node belongs to.
 *
 * Every node an edge touches is in the same run as the node at its other end,
 * whichever way the edge points: what matters for drawing is that they are one
 * piece of work, not which of them came first.
 * @param proposal - The proposal the card draws.
 * @returns One run number per node, in the proposal's own order.
 * @throws {never} Never.
 */
function runsOf(proposal: CanvasProposal): number[] {
  const run = proposal.nodes.map((_, at) => at);
  for (let pass = 0; pass < proposal.nodes.length; pass += 1) {
    let moved = false;
    for (const edge of proposal.edges) {
      const a = run[edge.fromIndex];
      const b = run[edge.toIndex];
      if (a === undefined || b === undefined || a === b) continue;
      const kept = Math.min(a, b);
      run.forEach((held, at) => {
        if (held === a || held === b) run[at] = kept;
      });
      moved = true;
    }
    if (!moved) break;
  }
  return run;
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
  // A mark asking for material is about the empty node it points at, and
  // several generations may point at the same one. Named under that node, it
  // is said once; named under each generation, the reader reads three photos
  // to find where there is one.
  const notes = new Map<number, string[]>();
  /**
   * Add one note under the node it belongs to.
   *
   * The same words arriving about one empty node from several generations is
   * one job, and said three times it reads as three photos to find. Two marks
   * in one prompt are two places even when they read the same, so a note
   * filed under the node whose prompt it came from is kept as written.
   * @param at - The node the note is about.
   * @param from - The node whose prompt marked it.
   * @param note - The line the card draws.
   */
  const add = (at: number, from: number, note: string): void => {
    const held = notes.get(at) ?? [];
    if (at !== from && held.includes(note)) return;
    notes.set(at, [...held, note]);
  };
  // The same reading the canvas writes its mentions from, so a to-do names
  // the node the bracket beside it will point at -- and where no mention is
  // written, the to-do falls under the generation whose panel it is done in.
  const empties = proposal.nodes.map((_, at) => nameableFeeders(proposal, at).sources);
  // How many generations would point at each empty node. Read once here
  // because it decides where the note goes: under the generation while it is
  // the only one reading that node, which is where the demo draws it and
  // where the reader is standing when they do it.
  const readers = new Map<number, number>();
  for (const list of empties) {
    for (const i of list) readers.set(i, (readers.get(i) ?? 0) + 1);
  }
  proposal.nodes.forEach((node, at) => {
    let assetsSeen = 0;
    const mine = empties[at] ?? [];
    for (const segment of node.prompt ?? []) {
      const slot = segment.slot;
      if (!slot) continue;
      if (slot.kind === 'ref') continue;
      if (slot.kind === 'tweak') {
        add(at, at, slot.note);
        continue;
      }
      const empty = mine[assetsSeen];
      assetsSeen += 1;
      // Shared, the note belongs to the node itself: said under each of three
      // generations it reads as three photos to find. Read by this one alone,
      // it belongs here, beside the button the reader presses after doing it.
      add(empty !== undefined && (readers.get(empty) ?? 0) > 1 ? empty : at, at, slot.note);
    }
  });
  const groups: NodeTodos[] = [];
  proposal.nodes.forEach((node, at) => {
    const held = notes.get(at);
    if (held === undefined) return;
    const same = groups.find(
      (group) =>
        group.notes.length === held.length &&
        group.notes.every((note, i) => note === held[i]),
    );
    if (same) same.nodes.push(node.name);
    else groups.push({ nodes: [node.name], notes: held });
  });
  return groups;
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
  const rows = proposal.nodes
    .filter((node) => node.role === 'generate')
    .map((node) => entryOf(catalog, node.model));
  if (rows.length === 0 || rows.some((row) => row === undefined)) return undefined;
  const known = rows.filter((row) => row !== undefined);
  // A model charging by what it is given has no per-call price at all, so a
  // total carrying it would be a number nobody can arrive at. The wait is the
  // longest of them: the runs that can start together do, and a run waiting on
  // the one before it is waiting on a press the reader has not made yet.
  const metered = known.some((row) => row.rate !== undefined);
  const times = known.map((row) => row.generation_time);
  return {
    ...(metered
      ? {}
      : { credits: known.reduce((sum, row) => sum + row.cost_per_call, 0) }),
    seconds: Math.max(...times),
    runs: known.length,
    sameLength: new Set(times).size === 1,
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
