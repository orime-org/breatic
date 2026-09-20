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
 * What a proposed node is, in the group the reader is about to place.
 *
 * `source` stands empty for them to drop material into, `generate` waits for
 * them to press Generate, and `written` already holds the words -- the only
 * one of the three whose content is finished before anything is placed.
 */
export type ProposalRole = "source" | "generate" | "written";

/** Every node kind a proposal can place: the three that generate, plus text. */
export type ProposalNodeType = GenerationNodeType | "text";

/** One node of a proposal, before anything is placed. */
export interface ProposalNode {
  role: ProposalRole;
  type: ProposalNodeType;
  name: string;
  mode?: string;
  model?: string;
  params?: Record<string, unknown>;
  prompt?: PromptSegment[];
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

/** What a refused proposal answers with, so the model can send a better one. */
export interface ProposalRefused {
  placed: false;
  reason: string;
}

/** What the tool answers with: the proposal itself, or why it was refused. */
export type ProposalAnswer = (CanvasProposal & { placed: true }) | ProposalRefused;
