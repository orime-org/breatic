// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What a proposal card says before the reader presses it (#229, design §5.5).
 *
 * The card has to answer three things in the space of a chat column: what gets
 * built, which model it runs on, and what is left for the reader afterwards.
 * All three are read off the proposal; the catalog only supplies the model's
 * display name.
 */

import { layersOf, modelLabel, proposalMarkSegments } from '@breatic/shared';
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

/**
 * The two lines that tell the reader where a generation's setup is found.
 *
 * Passed in rather than looked up here, so this file stays free of the
 * translation layer and the card decides the words.
 */
export interface PanelLines {
  /** For a generation whose prompt the agent wrote. */
  prompt: string;
  /** For one whose panel has no prompt box, or that carries no prompt. */
  settings: string;
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
 * what to do about it before pressing. Filed under the generation whose panel
 * it is done in, and nodes asking for the same things in the same words share
 * one group.
 *
 * Every generation ends with one more line saying where its setup is found:
 * what the agent wrote lives in the generation panel, and a reader new to the
 * canvas does not know a right-click opens it (#289).
 * @param proposal - The proposal the card draws.
 * @param lines - The words for that last line, in the reader's language.
 * @returns One group per node that asks for anything, in the proposal's order.
 * @throws {never} Never.
 */
export function todosOf(proposal: CanvasProposal, lines: PanelLines): NodeTodos[] {
  // Every mark is done in the panel of the generation whose prompt carries
  // it -- the reader @s by hand there -- so its line goes under that node.
  const notes = new Map<number, string[]>();
  proposal.nodes.forEach((node, at) => {
    const held: string[] = [];
    // The main prompt and then each shot, in the order the reader reads them.
    for (const segment of proposalMarkSegments(node)) {
      const slot = segment.slot;
      if (!slot) continue;
      // A note is its own line; the other marks carry the line to draw.
      held.push(slot.kind === 'note' ? slot.label : slot.note);
    }
    if (node.role === 'generate') {
      // A model drawing no prompt box shows nothing the agent wrote, so saying
      // the prompt is written would send the reader looking for a box that is
      // not there. The check has already answered which kind this is.
      const writtenPrompt = node.takesPrompt !== false && proposalMarkSegments(node).length > 0;
      held.push(writtenPrompt ? lines.prompt : lines.settings);
    }
    if (held.length > 0) notes.set(at, held);
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
 * @param mode - The mode it runs in, whose picker the name is the one of.
 * @returns The name to show, or undefined when the proposal names no model.
 * @throws {never} Never.
 */
export function nameOf(
  catalog: ModelCatalog | undefined,
  model: string | undefined,
  mode: string | undefined,
): string | undefined {
  const entry = entryOf(catalog, model);
  if (!entry || !catalog) return model;
  const peers = (catalog[entry.modality] ?? []).filter((m) => mode !== undefined && [m.mode].flat().includes(mode));
  return modelLabel(entry, peers) || model;
}
