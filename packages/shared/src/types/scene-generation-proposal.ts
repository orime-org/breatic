// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The shape of a proposed 3D generation (inner#1691).
 *
 * The agent's tool answers with one; the card in the chat column draws it, and
 * the 3D Space in front opens its generate dialog filled with it. It names no
 * Space: the user opens it in whichever 3D Space they have open, the way a
 * Canvas proposal lands on whichever Canvas is in front.
 */

import { z } from "zod";

/** A whole proposal: what the generate dialog is filled with, and what it costs. */
export const sceneGenerationProposalSchema = z.object({
  proposalId: z.string().uuid(),
  mode: z.enum(["t23d", "i23d"]),
  /** The 3D catalog entry. */
  model: z.string().min(1),
  /** Text to 3D only; null on an image run. */
  prompt: z.string().nullable(),
  /** The settings as `resolveParams` left them, `negative_prompt` among them. */
  params: z.record(z.string(), z.unknown()),
  /** The views in front, left, back, right order; empty on a text run. */
  images: z.array(z.object({ assetId: z.string().min(1), url: z.string().min(1) })),
  /** The estimate for those settings, as the dialog shows it. */
  credits: z.number(),
  /** One line on what it is for. */
  rationale: z.string(),
  /** A proposal the tool let through; a refusal is a `ProposalRefused`. */
  placed: z.literal(true),
});

/** A whole proposal, as {@link sceneGenerationProposalSchema} describes it. */
export type SceneGenerationProposal = z.infer<typeof sceneGenerationProposalSchema>;
