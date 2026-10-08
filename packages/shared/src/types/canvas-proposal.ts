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

import { t, tInEveryLocale } from "@shared/i18n/index.js";
import type { GenerationNodeType } from "@shared/types/model-catalog.js";

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

/** The kinds in the order {@link MARK_PATTERN} lists them, one capture group each. */
const MARK_KINDS = Object.keys(MARK_FORM) as SlotKind[];

/**
 * A mark as a template's locale prompt writes it, its label captured in the
 * group of its kind: the symbol picks the kind, so brackets the reader types
 * stay words.
 */
const MARK_PATTERN = new RegExp(
  MARK_KINDS.map((kind) => {
    const { open, symbol, close } = MARK_FORM[kind];
    return `\\${open}${symbol} ([^\\${close}]+)\\${close}`;
  }).join("|"),
  "gu",
);

/**
 * A reference mark's label with the words {@link markText} asks the reader
 * with taken back off. Tried in every language, since the box may have been
 * filled in another one than the language reading it now.
 * @param label - What sits between `[📎 ` and `]`.
 * @returns The label alone.
 * @throws {never} Never.
 */
function bareReferenceLabel(label: string): string {
  for (const wording of tInEveryLocale("canvas.promptMark.reference", { label: "\u0000" })) {
    const [before = "", after = ""] = wording.split("\u0000");
    if (label.length > before.length + after.length && label.startsWith(before) && label.endsWith(after)) {
      return label.slice(before.length, label.length - after.length);
    }
  }
  return label;
}

/**
 * Read a prompt into segments: each `[📎 …]`, `{✏️ …}` and `(💡 …)` becomes
 * the mark it stands for, the label doubling as the card's line where the
 * kind has one. The inverse of {@link markText}: a template's locale prompt
 * and a prompt copied out of a box read back to the same label.
 * @param text - The prompt as a locale file or a box writes it.
 * @returns Its segments.
 * @throws {never} Never.
 */
export function markedSegments(text: string): PromptSegment[] {
  const segments: PromptSegment[] = [];
  let at = 0;
  for (const match of text.matchAll(MARK_PATTERN)) {
    const [whole] = match;
    const group = match.findIndex((captured, i) => i > 0 && captured !== undefined);
    const kind = MARK_KINDS[group - 1] ?? "tweak";
    const read = match[group] ?? "";
    const label = kind === "asset" ? bareReferenceLabel(read) : read;
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
   * Whether the panel will draw a prompt box here, answered by the check.
   *
   * Carried on the node because the catalog is the authority, the check has
   * just read it, and a reader can press Use before the catalog has loaded on
   * the canvas. A model drawing no box mounts no editor, so the canvas writes
   * nothing there and the card lists the marks instead. Absent on a node that
   * generates nothing.
   */
  takesPrompt?: boolean;
}

/** A whole proposal, as the model sends it and the card reads it. */
export interface CanvasProposal {
  nodes: ProposalNode[];
  /**
   * The wiring. `into` says where the node wired in goes on the generation it
   * feeds: `"pool"` for the reference pool, or the name of one of its slots.
   */
  edges: Array<{ fromIndex: number; toIndex: number; into?: string }>;
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
