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

/** One stretch of the prompt: plain words, or a place the reader acts on. */
export type PromptSegment =
  | { text: string; slot?: undefined }
  | {
      text?: undefined;
      slot: { kind: "asset" | "tweak"; label: string; note: string };
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
 * @param slot - The spot the reader acts on.
 * @returns The bracketed text, as the reader will see it.
 * @throws {never} Never.
 */
export function markText(slot: NonNullable<PromptSegment["slot"]>): string {
  return `${MARK_OPEN}${MARK_SYMBOL[slot.kind]} ${slot.label}${MARK_CLOSE}`;
}

/**
 * The prompt as the box will hold it, marks and all.
 * @param segments - The proposed prompt.
 * @returns Every stretch of it, joined.
 * @throws {never} Never.
 */
export function promptTextOf(segments: readonly PromptSegment[]): string {
  return segments.map((s) => (s.slot ? markText(s.slot) : s.text)).join("");
}

/** One node of a proposal, before anything is placed. */
export interface ProposalNode {
  role: "source" | "generate";
  type: GenerationNodeType;
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
  modelNote: string;
  rationale: string;
}

/** What a refused proposal answers with, so the model can send a better one. */
export interface ProposalRefused {
  placed: false;
  reason: string;
}

/** What the tool answers with: the proposal itself, or why it was refused. */
export type ProposalAnswer = (CanvasProposal & { placed: true }) | ProposalRefused;
