// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Propose a 3D generation for the 3D Space (inner#1691 design 6.1).
 *
 * The proposal names no Space: the user presses the card's button in
 * whichever 3D Space they have open, and its generate dialog opens filled
 * with it. It is checked the way the submit route checks a submission (the
 * model and mode, the prompt, the number of views, the settings, and each
 * view resolved to an image of this Project), so a proposal that passes is
 * one the dialog can send. Nothing runs and nothing is held until the user
 * presses the dialog's round generate button.
 */

import { randomUUID } from "node:crypto";

import { tool, type Tool } from "ai";
import { z } from "zod";

import { AppError } from "@breatic/core";
import { SCENE_VIEW_SLOTS, THREE_D_GENERATION_MODES, type ParamViolation, type ProposalRefused, type SceneGenerationProposal } from "@breatic/shared";

import { resolveProjectImageInputs } from "@domain/asset/project-image-inputs.js";
import { estimateTaskCredits } from "@domain/model-catalog/model-catalog.js";
import { planSceneGeneration, type SceneGenerationProblem } from "@domain/model-catalog/scene-generation.js";
import { LIST_GENERATION_MODELS } from "@domain/agent/tools/tool-names.js";

/** What the tool answers with: the proposal, or why it was refused. */
export type SceneProposalAnswer = SceneGenerationProposal | ProposalRefused;

/** What this tool is handed in its context: the Project whose images a view may name. */
export interface ProposeSceneContext extends Record<string, unknown> {
  projectId: string;
}

const proposeSceneContextSchema: z.ZodType<ProposeSceneContext> = z.object({ projectId: z.string() });

const inputSchema = z
  .object({
    mode: z.enum(THREE_D_GENERATION_MODES).describe("t23d: text to 3D. i23d: picture to 3D."),
    model: z
      .string()
      .min(1)
      .describe(`A 3D model ${LIST_GENERATION_MODELS} returned for this mode with target "3d"; for i23d, the single image entry for one view, the multi-view entry for two to four.`),
    prompt: z.string().optional().describe("What to generate, for t23d only; i23d models take no prompt."),
    params: z
      .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
      .optional()
      .describe(`Settings the model declares, by name; one left out takes its default. For t23d, negative_prompt goes here too. A value against one of the model's forced values is refused.`),
    images: z
      .array(z.string().min(1))
      .optional()
      .describe(
        "For i23d: the views in front, left, back, right order, the front first. Each is an image of this Project, " +
          "named by its asset id or its address: one the user attached in chat, one saved with save_image, one added from a Canvas node, or one already in the Project.",
      ),
    rationale: z.string().describe("One line on what the model is for."),
  })
  .strict();

type SceneGenerationInput = z.infer<typeof inputSchema>;

/**
 * A refusal.
 * @param reason - What is wrong, the rule and the facts.
 * @returns The answer.
 */
function refused(reason: string): ProposalRefused {
  return { placed: false, reason };
}

/**
 * A broken settings rule, in words the agent reads.
 * @param v - The rule broken.
 * @returns The sentence.
 */
function violationWords(v: ParamViolation): string {
  switch (v.rule) {
    case "forced":
      return `"${v.param}" cannot be ${JSON.stringify(v.given)}: the forced value ${v.force} sets it to ${JSON.stringify(v.value)} with these settings. Leave "${v.param}" out, or change what triggers ${v.force}.`;
    case "values":
      return `"${v.param}" takes one of ${v.values.map((value) => JSON.stringify(value)).join(", ")}, not ${JSON.stringify(v.value)}.`;
    case "integer":
      return `"${v.param}" takes a whole number, not ${JSON.stringify(v.value)}.`;
    case "text":
      return `"${v.param}" takes text, not ${JSON.stringify(v.value)}.`;
    case "bounds":
      return `"${v.param}" runs from ${String(v.min ?? "any")} to ${String(v.max ?? "any")} with these settings, and this one is ${String(v.value)}.`;
    case "max_length":
    case "prompt_max_length":
      return `"${v.param}" takes at most ${String(v.max)} characters once cleaned, and this one has ${String(v.length)}.`;
    case "min_length":
      return `"${v.param}" takes at least ${String(v.min)} characters once cleaned, and this one has ${String(v.length)}.`;
  }
}

/**
 * Why a proposal does not hold together, in words the agent reads.
 * @param problem - What does not hold.
 * @returns The sentence.
 */
function problemWords(problem: SceneGenerationProblem): string {
  switch (problem.kind) {
    case "model":
      return `"${problem.model}" is not a 3D model serving ${problem.mode}. Ask ${LIST_GENERATION_MODELS} with target "3d" and mode ${problem.mode} for the ones that are.`;
    case "prompt":
      return problem.takesPrompt
        ? `"${problem.model}" generates from a prompt, and this proposal has none.`
        : `"${problem.model}" generates from pictures and takes no prompt; leave prompt out.`;
    case "image_count": {
      const takes =
        problem.max === 0
          ? "no images"
          : problem.min === problem.max
            ? `${String(problem.max)} image${problem.max === 1 ? "" : "s"}`
            : `${String(problem.min)} to ${String(problem.max)} images in ${SCENE_VIEW_SLOTS.join(", ")} order`;
      return `"${problem.model}" takes ${takes}, and this proposal gives ${String(problem.actual)}.`;
    }
    case "not_a_setting":
      return `"${problem.model}" has no setting "${problem.param}"; leave it out of params.`;
    case "violation":
      return violationWords(problem.violation);
  }
}

/**
 * The answer for one proposal.
 * @param input - What the agent sent.
 * @param projectId - The Project this turn runs in.
 * @returns The proposal, or why it was refused.
 * @throws {Error} When the catalog, the storage configuration or a database read fails.
 */
async function answerSceneGeneration(input: SceneGenerationInput, projectId: string): Promise<SceneProposalAnswer> {
  const views = input.images ?? [];
  const params = input.params ?? {};
  const plan = planSceneGeneration({ mode: input.mode, model: input.model, prompt: input.prompt, params, imageCount: views.length });
  if (!plan.ok) return refused(problemWords(plan.problem));
  let images: Array<{ assetId: string; url: string }> = [];
  try {
    if (views.length > 0) {
      images = (await resolveProjectImageInputs(projectId, views)).map(({ assetId, url }) => ({ assetId, url }));
    }
  } catch (err) {
    if (err instanceof AppError && err.statusCode === 422) return refused(err.message);
    throw err;
  }
  const credits = await estimateTaskCredits(plan.entry.name, { params: plan.params, prompt: plan.prompt ?? undefined });
  return {
    placed: true,
    proposalId: randomUUID(),
    mode: input.mode,
    model: plan.entry.name,
    prompt: plan.prompt === null ? null : (input.prompt ?? null),
    params: plan.params,
    images,
    credits,
    rationale: input.rationale,
  };
}

/**
 * The one line the model reads back. The proposal is for the user.
 * @param answer - What the tool answered.
 * @returns A sentence saying it is on screen, or why it is not.
 */
export function renderSceneProposalForModel(answer: SceneProposalAnswer): string {
  return answer.placed
    ? "The proposal is on screen as a card. The user opens it in a 3D Space they have open and presses the dialog's round generate button there."
    : `That proposal was refused, so nothing is on screen. ${answer.reason}`;
}

/**
 * The 3D generation proposal tool.
 * @returns The tool.
 */
export function makeProposeSceneGeneration(): Tool<SceneGenerationInput, SceneProposalAnswer, ProposeSceneContext> {
  return tool({
    description:
      "Propose a 3D model generation as a card. The 3D Space only generates 3D models, from a prompt (t23d) or " +
      "from one to four pictures of an object (i23d); pictures, videos and audio are generated on a Canvas. The " +
      "proposal names no Space: the user presses the card's button in the 3D Space they have open, and its " +
      "generate dialog opens filled with this proposal; nothing runs or costs anything until they press the dialog's " +
      `round generate button. Ask ${LIST_GENERATION_MODELS} with target "3d" first for the models, their settings and forced values. ` +
      "For i23d use pictures the user already has: one they attached, one saved here, one added from a Canvas " +
      "node or one in the Project. When there is no suitable picture, tell the user to generate one on a Canvas " +
      "first, or to attach one, and propose after that. The card shows the estimated credits.",
    inputSchema,
    contextSchema: proposeSceneContextSchema,
    metadata: { runningLine: "chat.tool.proposingSceneGeneration" },
    toModelOutput: ({ output }) => ({ type: "text", value: renderSceneProposalForModel(output) }),
    execute: (
      input: SceneGenerationInput,
      // The signal is unused: the check reads the catalog and a few rows.
      // Declared so every tool has the same shape.
      { context }: { abortSignal?: AbortSignal; context: ProposeSceneContext },
    ): Promise<SceneProposalAnswer> => answerSceneGeneration(input, context.projectId),
  });
}
