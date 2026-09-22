// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The shape of a proposed group of canvas nodes (#229).
 *
 * The model sends one of these through the propose tool; the card in the chat
 * column draws it, and the canvas places it. Three readers, so the shape lives
 * here rather than in any one of them -- the check that decides whether a
 * proposal holds together stays on the backend, because only it can read the
 * model catalog.
 */

import { insertRefusal } from "@shared/types/canvas-reference.js";
import type { GenerationNodeType } from "@shared/types/model-catalog.js";

/**
 * What a marked spot in the prompt asks of the reader.
 *
 * `asset` and `tweak` are things they do; `ref` is not -- it names an upstream
 * node this generation draws on, and lands as a mention with no bracket of its
 * own. Kept in one type because all three travel in the same prompt.
 */
export type SlotKind = "asset" | "tweak" | "ref";

/** One stretch of the prompt: plain words, or a place the reader acts on. */
export type PromptSegment =
  | { text: string; slot?: undefined }
  | {
      text?: undefined;
      slot: { kind: SlotKind; label: string; note: string };
    };

/** What brackets a spot the reader still has to fill in (design §5.4). */
const MARK_OPEN = "[";
const MARK_CLOSE = "]";

/** The symbol each kind of spot wears, so the two read apart at a glance. */
const MARK_SYMBOL: Readonly<Record<"asset" | "tweak", string>> = {
  asset: "📎",
  tweak: "✏️",
};

/**
 * What one marked spot puts in the prompt box.
 *
 * Written here because two sides need the same answer: the canvas writes this
 * into the box, and the check that decides whether a proposal holds together
 * counts it against the model's input cap. Spelled out twice, a proposal could
 * pass a count of one shape and land as another.
 *
 * A `ref` spot puts nothing there: it lands as a mention of the upstream node,
 * and a bracket counted here that never lands would put the count past what
 * the reader's box actually holds.
 * @param slot - The spot the reader acts on.
 * @returns The bracketed text, as the reader will see it.
 * @throws {never} Never.
 */
export function markText(slot: NonNullable<PromptSegment["slot"]>): string {
  if (slot.kind === "ref") return "";
  return `${MARK_OPEN}${MARK_SYMBOL[slot.kind]} ${slot.label}${MARK_CLOSE}`;
}

/**
 * The prompt as the panel will read it back, marks and all.
 *
 * Projected the way the canvas writes it and the editor gives it back: a line
 * break in a proposed stretch of text starts a new block, and the editor puts
 * two between blocks. Counted any other way, a proposal sits inside the
 * model's input cap here and past it by the time the reader presses Generate.
 * @param segments - The proposed prompt.
 * @returns The text the panel will measure.
 * @throws {never} Never.
 */
export function promptTextOf(segments: readonly PromptSegment[]): string {
  return segments
    .map((s) => (s.slot ? markText(s.slot) : s.text.replace(/\n/g, "\n\n")))
    .join("");
}

/**
 * The same words as they go into a text node's body.
 *
 * Apart from `promptTextOf` by one substitution, and it has to be: that one
 * answers "how much will the prompt box hold once the editor has been through
 * it", and an editor puts two line breaks between blocks. A text node's body
 * cuts its own blocks on single breaks, so doubling them there turns a note
 * with three breaks in it into six loose lines.
 *
 * The marks stay in the words either way -- a place the reader rewrites is
 * bracketed in the body exactly as it is in a prompt.
 * @param segments - The proposed words.
 * @returns The text to write into the body.
 * @throws {never} Never.
 */
export function promptPlainText(segments: readonly PromptSegment[]): string {
  return segments.map((s) => (s.slot ? markText(s.slot) : s.text)).join("");
}

/**
 * What a proposed node is, in the group the reader is about to place.
 *
 * `source` stands empty for them to drop material into, `generate` waits for
 * them to press Generate, and `written` already holds the words -- the only
 * one of the three whose content is finished before anything is placed.
 */
export type ProposalRole = "source" | "generate" | "written";

/** Every node kind a proposal can place: the three that generate, plus text. */
export type ProposalNodeType = GenerationNodeType | "text";

/**
 * Which way the reader's material reaches a generation.
 *
 * `pool` is fed by an edge and picked by a mention; `slot` is picked by the
 * reader clicking any node of that kind on the canvas. What a mark in the
 * prompt lands as differs by this, so the card and the canvas both ask it.
 */
export type MaterialPath = "pool" | "slot";

/** One node of a proposal, before anything is placed. */
export interface ProposalNode {
  role: ProposalRole;
  type: ProposalNodeType;
  name: string;
  mode?: string;
  model?: string;
  params?: Record<string, unknown>;
  prompt?: PromptSegment[];
  /**
   * How this generation takes material, answered by the check, not the model.
   *
   * The catalog is the authority and the check has just read it, so the
   * answer travels with the proposal rather than being asked again on the
   * canvas -- a reader can press Use before the catalog has loaded there, and
   * a guess either writes a mention the panel refuses or drops one the pool
   * needs. Absent on a node that generates nothing.
   */
  takesFrom?: MaterialPath;
  /**
   * Whether the panel will draw a prompt box here, answered by the check.
   *
   * Beside {@link ProposalNode.takesFrom} and carried for the same reason: the
   * catalog is the authority, the check has just read it, and a reader can
   * press Use before the catalog has loaded on the canvas. It decides what a
   * mark may name -- a model drawing no box mounts no editor and forces it
   * empty, so nothing in the prompt reaches the vendor. Absent on a node that
   * generates nothing.
   */
  takesPrompt?: boolean;
}

/** A whole proposal, as the model sends it and the card reads it. */
export interface CanvasProposal {
  nodes: ProposalNode[];
  edges: Array<{ fromIndex: number; toIndex: number }>;
  modelNote?: string;
  rationale: string;
  /**
   * What to call the group these nodes land in.
   *
   * Two or more nodes arrive inside a group, and only the model knows what
   * the group is for -- it just decided. One node places no group and needs
   * no name.
   */
  groupName?: string;
}

/** Which nodes feed one node of a proposal, split by what they carry. */
export interface ProposalFeederIndices {
  /** Indices of the empty nodes wired in, for the reader to fill. */
  sources: number[];
  /** Indices of the nodes wired in that already carry work of their own. */
  upstream: number[];
}

/**
 * What feeds one node of a proposal, in the order the nodes are listed.
 *
 * Node order rather than edge order, because that is the order the marks in
 * a prompt are numbered in: the k-th mark asking for material is about the
 * k-th empty node. Nothing makes a model list its edges the way it listed
 * its nodes, so reading the edge list gives the k-th mark whichever node
 * happened to be wired first -- and then the card names one node while the
 * canvas writes the mention against another.
 *
 * One function so the two cannot drift: the card draws its to-dos from it and
 * the canvas writes its mentions from it.
 * @param proposal - The proposal being read.
 * @param index - The node being fed.
 * @returns The feeder indices, split by role, each in node order.
 * @throws {never} Never.
 */
export function feedersOf(proposal: CanvasProposal, index: number): ProposalFeederIndices {
  const fedFrom = new Set(
    proposal.edges.filter((edge) => edge.toIndex === index).map((edge) => edge.fromIndex),
  );
  const sources: number[] = [];
  const upstream: number[] = [];
  proposal.nodes.forEach((node, at) => {
    if (!fedFrom.has(at)) return;
    (node.role === "source" ? sources : upstream).push(at);
  });
  return { sources, upstream };
}

/**
 * What one node's prompt may name and what its marks mention.
 *
 * One function because three sides read it and they have to agree: the check
 * decides how many marks are legal, the canvas writes that many mentions, and
 * the card files its to-dos by the same list. Read differently, a mark is
 * counted against one node and lands on another.
 *
 * What may be named is asked of {@link insertRefusal}, the panel's own picker
 * rule, rather than restated here: a mention this proposal writes is one the
 * reader would have had to make by hand, and a rule spelled out twice is one
 * the two spellings can part company behind. The row it is asked about is the
 * feeder; the mode and model facts it is asked with are the two the check
 * wrote onto this node when it read the catalog.
 *
 * A row stored before the check wrote them names nothing: what the panel
 * accepts turns on both, and a guess either writes a mention it refuses or
 * drops one the pool needs.
 * @param proposal - The proposal being read.
 * @param index - The node being fed.
 * @returns The feeders its marks may point at, each in node order.
 * @throws {never} Never.
 */
export function nameableFeeders(
  proposal: CanvasProposal,
  index: number,
): ProposalFeederIndices {
  const at = proposal.nodes[index];
  const path = at?.takesFrom;
  if (path === undefined || at?.takesPrompt === undefined) {
    return { sources: [], upstream: [] };
  }
  const held = feedersOf(proposal, index);
  const ctx = { takesReferences: path === "pool", takesPrompt: at.takesPrompt };
  /**
   * Whether the panel would take an `@`-mention of one feeder.
   * @param i - The feeder's index in the proposal.
   * @returns True when a mention of it is one the reader could have made.
   * @throws {never} Never.
   */
  const mentionable = (i: number): boolean => {
    const node = proposal.nodes[i];
    return node !== undefined && insertRefusal(node.type, ctx) === null;
  };
  return {
    // An asset mark mentions the empty node it names only where that mention
    // is what picks the material. Through a slot the reader picks by clicking
    // and the bracket alone names the slot to pick it in.
    sources: path === "pool" ? held.sources.filter(mentionable) : [],
    upstream: held.upstream.filter(mentionable),
  };
}

/**
 * How far downstream each node of a proposal sits, counting from what starts it.
 *
 * One further than the last thing that feeds it. Both the card's little
 * diagram and the arrangement on the canvas are drawn from this, so the depth
 * a node is at is one answer -- read twice, the two drift the first time
 * either is changed. What each does on top of it differs: the card splits its
 * chips into runs, and the canvas puts every node of one depth in one column.
 *
 * The walk is bounded by the node count rather than run to a fixed point: the
 * check refuses a ring before any of this is reached, so it settles long
 * before the bound, and a stored row that arrived some other way cannot spin.
 * @param proposal - The proposal being read.
 * @returns One depth per node, in the proposal's own order.
 * @throws {never} Never.
 */
export function layersOf(proposal: CanvasProposal): number[] {
  const depth = proposal.nodes.map(() => 0);
  for (let pass = 0; pass < proposal.nodes.length; pass += 1) {
    let moved = false;
    for (const edge of proposal.edges) {
      const from = depth[edge.fromIndex];
      const to = depth[edge.toIndex];
      if (from === undefined || to === undefined || to > from) continue;
      depth[edge.toIndex] = from + 1;
      moved = true;
    }
    if (!moved) break;
  }
  return depth;
}

/** What a refused proposal answers with, so the model can send a better one. */
export interface ProposalRefused {
  placed: false;
  reason: string;
}

/** What the tool answers with: the proposal itself, or why it was refused. */
export type ProposalAnswer = (CanvasProposal & { placed: true }) | ProposalRefused;
