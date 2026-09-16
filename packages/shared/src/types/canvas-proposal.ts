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
