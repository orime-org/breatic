// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The tools that start work on our models (breatic#1488 §9). Each returns a
 * task id at once; the task's end arrives in finishedTasks or through
 * get_task_result. A run is built as the user's own press builds it: collab
 * reads the node's settings, the panel's view model and plan (shared) turn
 * them into the same gate and the same request body, and the server's own
 * route starts it, with its limits, credit hold and idempotency key.
 */

import { t, type ModelCatalog } from "@breatic/shared";
import {
  AUDIO_MODE_OPTIONS,
  VIDEO_MODE_OPTIONS,
  asContentView,
  audioSlotsForModel,
  buildAudioPanelViewModel,
  buildGeneratePanelViewModel,
  buildVideoPanelViewModel,
  deriveReferences,
  filterAvailableModes,
  modelTakesLyrics,
  modelsForModality,
  nodeVideoMode,
  planAudioRun,
  planImageRun,
  planVideoRun,
  resolveAvailableMode,
  serializeDialoguePieces,
  serializePromptPieces,
  storyboardRun,
  storyboardSpecOf,
  storyboardTotal,
  withListDefaultVoice,
  type CanvasEdge,
  type CanvasNodeView,
  type PromptPieceBlock,
  type RunPlan,
} from "@breatic/shared/canvas-model";
import { z } from "zod";
import { defineTool, idempotencyKey, runCommandNow, ToolRefusal, type ToolDeps } from "@mcp/tools/kit.js";

/** What collab reads off a node for a run. */
interface GenerationInputs {
  nodes: CanvasNodeView[];
  edges: CanvasEdge[];
  textById: Record<string, string>;
  prompts: Record<string, PromptPieceBlock[]>;
  lyrics: Record<string, PromptPieceBlock[]>;
  shots: Array<{ duration: number; prompt: PromptPieceBlock[] }>;
}

/** Lyrics are written one line per line, as the lyrics box joins them (#1960). */
const LYRICS_SEPARATOR = "\n";

/**
 * The nodes a prompt @-mentions.
 * @param blocks - The prompt's pieces.
 * @returns Their ids.
 */
function mentionsIn(blocks: readonly PromptPieceBlock[]): string[] {
  return blocks.flatMap((block) => block.pieces.flatMap((piece) => ("mention" in piece ? [piece.mention.sourceNodeId] : [])));
}

/**
 * The run a node's own panel would make of it now.
 * @param deps - The call.
 * @param where - The node.
 * @param where.projectId - Its Project.
 * @param where.spaceId - Its Space.
 * @param where.nodeId - The node.
 * @param inputs - What collab read off it.
 * @param catalog - The model catalog.
 * @returns The plan.
 * @throws {ToolRefusal} When the node does not generate.
 */
async function planFor(deps: ToolDeps, where: { projectId: string; spaceId: string; nodeId: string }, inputs: GenerationInputs, catalog: ModelCatalog): Promise<RunPlan> {
  const { nodeId } = where;
  const node = inputs.nodes.find((one) => one.id === nodeId);
  const { nodes, edges } = inputs;
  const textById: ReadonlyMap<string, string> = new Map(Object.entries(inputs.textById));
  if (node?.type === "image") {
    const models = modelsForModality(catalog, "image");
    const probe = buildGeneratePanelViewModel({ nodeId, nodes, edges, models, textById });
    const blocks = inputs.prompts[probe.mode] ?? [];
    const vm = buildGeneratePanelViewModel({ nodeId, nodes, edges, models, textById, atMentionedSourceIds: new Set(mentionsIn(blocks)) });
    return planImageRun({ ...where, vm, promptOf: () => serializePromptPieces(blocks, vm.references, vm.mentionTokens) });
  }
  if (node?.type === "video") {
    const models = modelsForModality(catalog, "video");
    const mode = nodeVideoMode(nodes, nodeId, filterAvailableModes(VIDEO_MODE_OPTIONS, models));
    const probe = buildVideoPanelViewModel({ nodeId, nodes, edges, models, mode, textById });
    // The multi-shot mode sends the shots and reads the sources they mention.
    const spec = storyboardSpecOf(probe.modelEntry, probe.mode);
    const shots = spec ? inputs.shots : [];
    const blocks = inputs.prompts[probe.mode] ?? [];
    const mentioned = spec ? shots.flatMap((shot) => mentionsIn(shot.prompt)) : mentionsIn(blocks);
    const vm = buildVideoPanelViewModel({ nodeId, nodes, edges, models, mode, textById, atMentionedSourceIds: new Set(mentioned) });
    const run = storyboardRun(
      spec,
      shots.map((shot) => ({ prompt: serializePromptPieces(shot.prompt, vm.references, vm.mentionTokens), duration: shot.duration })),
      storyboardTotal(spec, vm.params),
    );
    return planVideoRun({ ...where, vm, run, promptOf: () => serializePromptPieces(blocks, vm.references, vm.mentionTokens) });
  }
  if (node?.type === "audio") {
    const models = modelsForModality(catalog, "audio");
    const mode = resolveAvailableMode(asContentView(node.data)?.mode, filterAvailableModes(AUDIO_MODE_OPTIONS, models)) ?? "";
    const built = buildAudioPanelViewModel({ nodeId, nodes, models, mode });
    // With no voice held, the first voice of the model's list is the voice (user 2026-09-29).
    const first = built.voiceRequired && !built.voiceChosen ? await firstVoice(deps, built.model) : undefined;
    const vm = withListDefaultVoice(built, first);
    const pool = deriveReferences(nodeId, nodes, edges, textById);
    const blocks = inputs.prompts[mode] ?? [];
    const lyricBlocks = inputs.lyrics[mode] ?? [];
    return planAudioRun({
      ...where,
      vm,
      mode,
      slots: audioSlotsForModel(vm.modelEntry, mode, vm.params),
      lyrics: modelTakesLyrics(vm.modelEntry, mode),
      promptOf: () => (vm.dialogueNames === null ? serializePromptPieces(blocks, pool, {}) : serializeDialoguePieces(blocks, pool, vm.dialogueNames, {})),
      lyricsOf: () => serializePromptPieces(lyricBlocks, pool, {}, LYRICS_SEPARATOR),
    });
  }
  throw new ToolRefusal("invalid_request", "That node does not generate: only image, video and audio nodes do.");
}

/**
 * The first voice of a model's list.
 * @param deps - The call.
 * @param model - The model.
 * @returns The voice, or null when the list is empty.
 */
async function firstVoice(deps: ToolDeps, model: string): Promise<{ id: string } | null> {
  const page = await deps.api.get<{ voices: Array<{ id: string }> }>(`/models/${encodeURIComponent(model)}/voices`, { query: "" });
  return page.voices[0] ?? null;
}

/**
 * The words a refused run shows the user, for the agent.
 * @param plan - The refused plan.
 * @returns The refusal.
 */
function refusalOf(plan: Extract<RunPlan, { kind: "refused" }>): ToolRefusal {
  const { text, verdict } = plan;
  const message =
    text === null
      ? `The node cannot generate now (${verdict.refusal}).`
      : "message" in text
        ? text.message
        : t(text.key, { ...text.values, name: text.paramNameKey === undefined ? "" : t(text.paramNameKey) });
  return new ToolRefusal(verdict.refusal, message);
}

/** What the run routes answer. */
interface StartedTask {
  task_id: string;
  status: "pending" | "failed";
}

export const runGeneration = defineTool({
  name: "run_generation",
  description:
    "Generate into an image, video or audio node from its current settings, exactly as pressing Generate in its panel does: its mode, model, parameters, prompt (with its @-mentioned references), " +
    "storyboard shots, lyrics and slots; an audio node with no voice chosen uses the model's first voice. Set the settings first with update_canvas_node. " +
    "Charged to the user's credits. Returns a task id at once; the result lands on the node and arrives in finishedTasks, or ask get_task_result. " +
    "Refused, with the words the panel would show, when the node is missing a prompt, a reference or a voice; a locked node is refused.",
  input: z.object({ projectId: z.uuid(), spaceId: z.uuid(), nodeId: z.uuid().describe("The image, video or audio node.") }),
  readOnly: false,
  run: async (deps, args) => {
    const [inputs, catalog] = await Promise.all([
      runCommandNow(deps, { type: "read_generation_inputs", projectId: args.projectId, spaceId: args.spaceId, params: { nodeId: args.nodeId } }) as Promise<GenerationInputs>,
      deps.api.get<ModelCatalog>("/models"),
    ]);
    const plan = await planFor(deps, args, inputs, catalog);
    if (plan.kind === "refused") throw refusalOf(plan);
    const started = await deps.api.post<StartedTask>("/canvas/tasks", plan.payload, { idempotencyKey: idempotencyKey() });
    await deps.tasks.track(started.task_id, "run_generation");
    return { value: { taskId: started.task_id, nodeId: args.nodeId } };
  },
});

/** The generation tools. */
export const GENERATION_TOOLS = [runGeneration];
