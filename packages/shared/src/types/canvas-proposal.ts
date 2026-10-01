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
import type { ReferenceKind } from "@shared/reference-pool.js";

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

/** One shot of a proposed per-shot storyboard. */
export interface ProposalShot {
  prompt: PromptSegment[];
  duration: number;
}

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
   * The storyboard tier to set (#2218): `auto` lets the model split the main
   * prompt into shots. Absent means none, unless {@link ProposalNode.shots}
   * sets the per-shot tier.
   */
  storyboard?: "auto";
  /**
   * The shots of a per-shot storyboard (#2218), each with its own prompt and
   * whole seconds. Present means the node lands in the per-shot tier.
   */
  shots?: ProposalShot[];
  /**
   * The kinds this generation's reference pool takes, answered by the check,
   * not the model (#2156: a model takes pictures, clips and tracks each in a
   * pool of its own). Empty when its material arrives by a slot the reader
   * clicks a node into; a pool is fed by an edge and picked by a mention.
   *
   * The catalog is the authority and the check has just read it, so the
   * answer travels with the proposal rather than being asked again on the
   * canvas -- a reader can press Use before the catalog has loaded there, and
   * a guess either writes a mention the panel refuses or drops one the pool
   * needs. Absent on a node that generates nothing.
   */
  poolKinds?: ReferenceKind[];
  /**
   * One entry per slot the model cannot run without, by the kind it takes,
   * answered by the check beside {@link ProposalNode.poolKinds}. A model can
   * take one kind both ways -- Kling O3 wants a first frame in a slot and
   * builds elements out of mentioned pictures -- and the reader's material
   * fills the slot first: a run without it cannot go.
   */
  slotKinds?: ReferenceKind[];
  /**
   * Whether the panel will draw a prompt box here, answered by the check.
   *
   * Beside {@link ProposalNode.poolKinds} and carried for the same reason: the
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

/**
 * Which feeders a prompt may name, in node order.
 *
 * `null` where the panel would not take a mention of that node. The place is
 * kept rather than dropped because the k-th mark is about the k-th entry:
 * compacted, every mark after the unmentionable one slides onto the node next
 * along. The upstream list leaves out the nodes that fill a required slot,
 * which the reader picks in the panel.
 */
export interface NameableFeederIndices {
  /** Indices of the empty nodes wired in, null where none can be mentioned. */
  sources: (number | null)[];
  /**
   * The same for the nodes wired in that carry work of their own, past the
   * ones in `slotted`: a ref mark's mention is its whole text, so the slot's
   * node has no mark to keep a place for.
   */
  upstream: (number | null)[];
  /**
   * The nodes wired in that fill a required slot, in node order. The reader
   * picks each into its slot in the panel, so none of them is mentioned.
   */
  slotted: number[];
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
 * asks whether a mention can be carried here at all, the canvas writes the
 * mentions, and the card files its to-dos by the same list. Read differently,
 * a mark is filed under one node and lands on another.
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
): NameableFeederIndices {
  const at = proposal.nodes[index];
  const poolKinds = at?.poolKinds;
  if (poolKinds === undefined || at?.takesPrompt === undefined) {
    return { sources: [], upstream: [], slotted: [] };
  }
  const byPool = poolKinds.length > 0;
  const held = feedersOf(proposal, index);
  const ctx = { referenceKinds: poolKinds, takesPrompt: at.takesPrompt };
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
  // The required slots still open, by kind. Each node of that kind wired in
  // takes one, in the order the nodes are listed, before any reaches the pool.
  const open = [...(at.slotKinds ?? [])];
  const slotted: number[] = [];
  for (const i of [...held.sources, ...held.upstream].sort((a, b) => a - b)) {
    const slot = open.indexOf(proposal.nodes[i]?.type as ReferenceKind);
    if (slot === -1) continue;
    open.splice(slot, 1);
    slotted.push(i);
  }
  /**
   * One entry per node in the list, the index where it can be mentioned.
   * @param list - The feeders, in the order the nodes are listed.
   * @param can - Whether a mention is possible for this run at all.
   * @returns The same length, null where no mention can be written.
   * @throws {never} Never.
   */
  const keepingPlaces = (list: readonly number[], can: boolean): (number | null)[] =>
    list.map((i) => (can && !slotted.includes(i) && mentionable(i) ? i : null));
  return {
    // An asset mark mentions the empty node it names only where that mention
    // is what picks the material. Through a slot the reader picks by clicking
    // and the bracket alone names the slot to pick it in.
    sources: keepingPlaces(held.sources, byPool),
    upstream: keepingPlaces(held.upstream.filter((i) => !slotted.includes(i)), true),
    slotted,
  };
}

/**
 * Every segment of a node that can carry a mark, in the one order the tool,
 * the card and the canvas all pair marks with feeders by: the main prompt,
 * then each shot in turn (#2218).
 * @param node - The proposed node.
 * @returns The segments in pairing order.
 * @throws {never} Never.
 */
export function proposalMarkSegments(node: ProposalNode): PromptSegment[] {
  return [...(node.prompt ?? []), ...(node.shots ?? []).flatMap((shot) => shot.prompt)];
}

/**
 * The feeders one node's prompt actually sends: the k-th asset mark sends the
 * k-th entry of {@link nameableFeeders}' sources, the k-th ref mark the k-th
 * upstream entry, the way the canvas writes its mentions. A node wired in and
 * never marked is not sent.
 * @param proposal - The proposal being read.
 * @param index - The node being fed.
 * @returns The indices the marks send, in the order the marks appear.
 * @throws {never} Never.
 */
export function markTargets(proposal: CanvasProposal, index: number): number[] {
  const node = proposal.nodes[index];
  const named = nameableFeeders(proposal, index);
  const sent: number[] = [];
  let assets = 0;
  let refs = 0;
  for (const segment of node ? proposalMarkSegments(node) : []) {
    const kind = segment.slot?.kind;
    const target = kind === "asset" ? named.sources[assets++] : kind === "ref" ? named.upstream[refs++] : undefined;
    if (target !== undefined && target !== null) sent.push(target);
  }
  return sent;
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
