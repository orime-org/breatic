// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The shapes of a 3D generation (inner#1691): what the 3D Space's dialog
 * submits, what the server answers, and what the agent proposes.
 *
 * The agent's tool answers with a proposal; the card in the chat column draws it, and
 * the 3D Space in front opens its generate dialog filled with it. It names no
 * Space: the user opens it in whichever 3D Space they have open, the way a
 * Canvas proposal lands on whichever Canvas is in front.
 */

import { z } from "zod";

import { THREE_D_GENERATION_MODES } from "@shared/types/model-catalog.js";

/** A whole proposal: what the generate dialog is filled with, and what it costs. */
export const sceneGenerationProposalSchema = z.object({
  proposalId: z.string().uuid(),
  mode: z.enum(THREE_D_GENERATION_MODES),
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

/** What the generation dialog submits. */
export const sceneGenerationBodySchema = z.object({
  mode: z.enum(THREE_D_GENERATION_MODES),
  /** `tasks.model` is varchar(100). */
  model: z.string().min(1).max(100),
  prompt: z.string().max(8192).optional(),
  // The settings, `negative_prompt` among them; each is judged against the
  // model's own declarations, so the shape here only bounds the values.
  params: z.record(z.string().max(64), z.union([z.string().max(8192), z.number(), z.boolean(), z.null()])),
  // The views in front, left, back, right order. How many the model takes is
  // its rule, said with its name when broken; the cap here only bounds work.
  image_asset_ids: z.array(z.string().uuid()).max(16).optional(),
  origin: z.enum(["space", "agent"]),
});

/** A submission, as {@link sceneGenerationBodySchema} describes it. */
export type SceneGenerationBody = z.infer<typeof sceneGenerationBodySchema>;

/** What a submission answers: the task, its row, and whether the job was queued. */
export interface SceneGenerationAnswer {
  task_id: string;
  row_id: string;
  status: "pending" | "failed";
}
