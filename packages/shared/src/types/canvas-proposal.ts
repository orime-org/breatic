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

import { t } from "@shared/i18n/index.js";
import { insertRefusal } from "@shared/types/canvas-reference.js";
import type { GenerationNodeType } from "@shared/types/model-catalog.js";
import type { ReferenceKind } from "@shared/reference-pool.js";

/**
 * What a marked spot in the prompt asks of the reader (inner#977): `asset`
 * names something to @ by hand, `tweak` words to fill in, and `note` how to
 * operate the panel -- shown to the reader and never sent to the model.
 */
export type SlotKind = "asset" | "tweak" | "note";

/** One stretch of the prompt: plain words, or a place the reader acts on. */
export type PromptSegment =
  | { text: string; slot?: undefined }
  | {
      text?: undefined;
      slot:
        | { kind: "asset" | "tweak"; label: string; note: string }
        | { kind: "note"; label: string; note?: undefined };
    };

/** The brackets and symbol each kind wears where it is written as words. */
const MARK_FORM: Readonly<Record<SlotKind, { open: string; symbol: string; close: string }>> = {
  asset: { open: "[", symbol: "📎", close: "]" },
  tweak: { open: "{", symbol: "✏️", close: "}" },
  note: { open: "(", symbol: "💡", close: ")" },
};

/**
 * What one marked spot puts in the prompt text.
 *
 * Written here because two sides need the same answer: the canvas writes this
 * into the box, and the check that decides whether a proposal holds together
 * counts it against the model's input cap. Spelled out twice, a proposal could
 * pass a count of one shape and land as another.
 *
 * A note puts nothing in the text: it lands as a block of its own that is
 * left out of what the model receives.
 * @param slot - The spot the reader acts on.
 * @returns The bracketed text, as the reader will see it.
 * @throws {never} Never.
 */
export function markText(slot: NonNullable<PromptSegment["slot"]>): string {
  if (slot.kind === "note") return "";
  const { open, symbol, close } = MARK_FORM[slot.kind];
  const words = slot.kind === "asset" ? t("canvas.promptMark.reference", { label: slot.label }) : slot.label;
  return `${open}${symbol} ${words}${close}`;
}

/**
 * A mark as a template's locale prompt writes it, kind and label captured:
 * the symbol picks the kind, so brackets the reader types stay words.
 */
const MARK_PATTERN = new RegExp(
  Object.values(MARK_FORM)
    .map(({ open, symbol, close }) => `\\${open}(${symbol}) ([^\\${close}]+)\\${close}`)
    .join("|"),
  "gu",
);

/**
 * Read a template's prompt, as the locale files keep it, into segments: each
 * `[📎 …]`, `{✏️ …}` and `(💡 …)` becomes the mark it stands for, the label
 * doubling as the card's line where the kind has one.
 * @param text - The prompt as the locale file writes it.
 * @returns Its segments.
 * @throws {never} Never.
 */
export function markedSegments(text: string): PromptSegment[] {
  const kindOf = new Map(Object.entries(MARK_FORM).map(([kind, form]) => [form.symbol, kind as SlotKind]));
  const segments: PromptSegment[] = [];
  let at = 0;
  for (const match of text.matchAll(MARK_PATTERN)) {
    const [whole] = match;
    const symbol = match.find((group, i) => i > 0 && kindOf.has(group ?? "")) ?? "";
    const label = match[match.indexOf(symbol) + 1] ?? "";
    const kind = kindOf.get(symbol) ?? "tweak";
    if (match.index > at) segments.push({ text: text.slice(at, match.index) });
    segments.push({ slot: kind === "note" ? { kind, label } : { kind, label, note: label } });
    at = match.index + whole.length;
  }
  if (at < text.length) segments.push({ text: text.slice(at) });
  return segments;
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

/** One shot of a proposed multi-shot generation. */
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
   * The shots of a multi-shot generation, each with its own prompt and whole
   * seconds; given in the `multi_shot` mode only, where they stand in for the
   * main prompt.
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
   * canvas -- a reader can press Use before the catalog has loaded there.
   * Absent on a node that generates nothing.
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

/** Which feeders the reader could @ in a prompt, and which a slot takes instead. */
export interface NameableFeederIndices {
  /** The feeders the panel would take an @ of, past the ones in `slotted`, in node order. */
  mentionable: number[];
  /**
   * The feeders a required slot takes, in node order: the first nodes of each
   * kind, one per entry in {@link ProposalNode.slotKinds}. The reader picks
   * each in the panel, so none of them is @'d.
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
 * Node order rather than edge order, so a refusal names the nodes in the
 * order the model wrote them.
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
 * Which feeders of one node the reader could @ in its prompt.
 *
 * What may be @'d is asked of {@link insertRefusal}, the panel's own picker
 * rule, rather than restated here: a rule spelled out twice is one the two
 * spellings can part company behind. The row it is asked about is the feeder;
 * the mode and model facts it is asked with are the two the check wrote onto
 * this node when it read the catalog.
 *
 * A row stored before the check wrote them names nothing: what the panel
 * accepts turns on both.
 * @param proposal - The proposal being read.
 * @param index - The node being fed.
 * @returns The feeders the reader could @, and those a slot takes.
 * @throws {never} Never.
 */
export function nameableFeeders(
  proposal: CanvasProposal,
  index: number,
): NameableFeederIndices {
  const at = proposal.nodes[index];
  const poolKinds = at?.poolKinds;
  if (poolKinds === undefined || at?.takesPrompt === undefined) {
    return { mentionable: [], slotted: [] };
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
  const wired = [...held.sources, ...held.upstream].sort((a, b) => a - b);
  for (const i of wired) {
    const slot = open.indexOf(proposal.nodes[i]?.type as ReferenceKind);
    if (slot === -1) continue;
    open.splice(slot, 1);
    slotted.push(i);
  }
  return {
    // An empty node is @'d only where that mention is what picks the
    // material; through a slot the reader clicks it in instead.
    mentionable: wired.filter(
      (i) => !slotted.includes(i) && (byPool || !held.sources.includes(i)) && mentionable(i),
    ),
    slotted,
  };
}

/**
 * Every segment of a node that can carry a mark: the main prompt, then each
 * shot in turn (#2218).
 * @param node - The proposed node.
 * @returns The segments, prompt first.
 * @throws {never} Never.
 */
export function proposalMarkSegments(node: ProposalNode): PromptSegment[] {
  return [...(node.prompt ?? []), ...(node.shots ?? []).flatMap((shot) => shot.prompt)];
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
