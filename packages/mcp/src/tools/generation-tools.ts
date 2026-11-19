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
  understandRefusal,
} from "@breatic/shared/canvas-model";
import {
  MINI_TOOLS,
  isModelTool,
  miniToolById,
  miniToolRequestOf,
  modelOf,
  modelToolParams,
  promptRequired,
  sizeTierChoices,
  slotFilled,
  slotLengthCap,
  slotOptional,
  sourceLimitOf,
  type MiniToolSlotValue,
  type MiniToolSlots,
  type MiniToolSourceInfo,
  type ModelToolSpec,
} from "@breatic/shared/mini-tools";
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

/** The two readings of a file into a text node, as the node menu offers them. */
const READINGS = {
  understand: { route: "/canvas/understand", tool: "understand_node", reads: new Set(["image", "video", "audio"]) },
  transcribe: { route: "/canvas/transcribe", tool: "transcribe_node", reads: new Set(["audio", "video"]) },
} as const;

/** What the readings take. */
const readingInput = z.object({
  projectId: z.uuid(),
  spaceId: z.uuid(),
  nodeId: z.uuid().describe("The node whose file is read."),
  language: z
    .string()
    .min(2)
    .max(35)
    .optional()
    .describe("The language the text is written in, as a BCP 47 tag such as en or zh-CN; use the language the user writes to you in."),
});

/**
 * Read a node's file into a new text node wired from it, as the node menu's
 * Understand and Transcribe do: refuse what the file's format rules out,
 * place the text node, then ask the server to read into it.
 * @param deps - The call.
 * @param reading - Which reading.
 * @param args - The node and the language.
 * @param extra - What one reading's route takes besides.
 * @returns The task and the text node.
 * @throws {ToolRefusal} When the node holds no file this reading takes.
 */
async function startReading(
  deps: ToolDeps,
  reading: keyof typeof READINGS,
  args: z.infer<typeof readingInput>,
  extra: Record<string, unknown>,
): Promise<{ value: { taskId: string; nodeId: string } }> {
  const where = { projectId: args.projectId, spaceId: args.spaceId };
  const read = (await runCommandNow(deps, { type: "read_canvas", ...where, params: { nodeIds: [args.nodeId] } })) as { nodes: CanvasNodeView[] };
  const source = read.nodes.find((node) => node.id === args.nodeId);
  // A media node's fields, as the node view carries them.
  const data = source?.data as { content?: unknown; mimeType?: string; sizeBytes?: number } | undefined;
  const url = typeof data?.content === "string" ? data.content : "";
  if (!source || !READINGS[reading].reads.has(source.type) || url === "") {
    throw new ToolRefusal("invalid_request", `Only a ${[...READINGS[reading].reads].join(", ")} node holding a file can be read this way.`);
  }
  const kind = source.type as "image" | "video" | "audio";
  // The size ceiling is the server's to judge here; the format is judged as the menu judges it.
  const refusal = understandRefusal({ kind, mimeType: data?.mimeType, sizeBytes: data?.sizeBytes, url }, null, null);
  if (refusal?.kind === "format") {
    throw new ToolRefusal("unsupported_format", `This file's format (${refusal.type}) cannot be read; convert it to a common ${kind} format and upload it first.`);
  }
  const { nodeId } = (await runCommandNow(deps, { type: "create_reading_node", ...where, params: { sourceNodeId: args.nodeId, reading } })) as { nodeId: string };
  const body = {
    project_id: args.projectId,
    space_id: args.spaceId,
    source_type: kind,
    source_url: url,
    node_ids: [nodeId],
    ...(data?.mimeType === undefined ? {} : { source_mime_type: data.mimeType }),
    // The answer is written in this language; the old name rides along for a server of the previous release.
    ...(args.language === undefined ? {} : { user_locale: args.language, reader_locale: args.language }),
    ...extra,
  };
  const started = await deps.api.post<StartedTask>(READINGS[reading].route, body, { idempotencyKey: idempotencyKey() });
  await deps.tasks.track(started.task_id, READINGS[reading].tool);
  return { value: { taskId: started.task_id, nodeId } };
}

export const understandNode = defineTool({
  name: "understand_node",
  description:
    "Describe what an image, video or audio node holds, as the node menu's Understand does: a new text node wired from it receives the description. Charged to the user's credits. " +
    "Returns the task id and the text node's id at once; the text arrives in finishedTasks, or ask get_task_result.",
  input: readingInput,
  readOnly: false,
  run: (deps, args) => startReading(deps, "understand", args, {}),
});

export const transcribeNode = defineTool({
  name: "transcribe_node",
  description:
    "Write down what is said in an audio or video node, as the node menu's Transcribe does: a new text node wired from it receives the words. Charged to the user's credits. " +
    "Returns the task id and the text node's id at once; the text arrives in finishedTasks, or ask get_task_result.",
  input: readingInput.extend({ keepFillers: z.boolean().default(false).describe("Keep fillers such as um and uh, as the menu's switch does.") }),
  readOnly: false,
  run: (deps, { keepFillers, ...args }) => startReading(deps, "transcribe", args, { keep_fillers: keepFillers }),
});

/** A media node's fields, as the node view carries them. */
interface MediaData {
  content?: unknown;
  mimeType?: string;
  sizeBytes?: number;
  width?: number;
  height?: number;
  duration?: number;
  name?: string;
}

/**
 * A node's pick, as a slot holds it.
 * @param node - The node.
 * @returns The pick, or undefined when the node holds no file.
 */
function pickOf(node: CanvasNodeView): MiniToolSlotValue | undefined {
  const data = node.data as MediaData;
  if (typeof data.content !== "string" || data.content === "") return undefined;
  return { url: data.content, nodeId: node.id, ...(data.duration === undefined ? {} : { duration: data.duration }), ...(data.name === undefined ? {} : { name: data.name }) };
}

/** The tools that call our models, as the agent picks one. */
const MODEL_TOOLS = MINI_TOOLS.filter(isModelTool);

/** What a model tool's run is refused for, in the panel's order and the panel's names. */
type ToolRefusalReason = "sourceMissing" | "noUsableTier" | "slotMissing" | "slotTooLong" | "sourceTooLong" | "sourceTooLarge" | "drawingEmpty" | "frameNotExpanded" | "promptMissing";

/** What each refusal tells the agent. */
const TOOL_REFUSAL_TEXT: Readonly<Record<ToolRefusalReason, string>> = {
  sourceMissing: "The node holds no file this tool reads, or its size or length is not known yet.",
  noUsableTier: "None of the tool's output sizes fits this source.",
  slotMissing: "A slot the tool needs is empty; name a node for it in slots.",
  slotTooLong: "The clips in a slot add up past what the model takes.",
  sourceTooLong: "The source is longer than the model takes.",
  sourceTooLarge: "The source file is larger than the model takes.",
  drawingEmpty: "This tool paints on the picture: upload the mask (white where to change, black elsewhere) or the sketch with begin_upload (destination detached) and pass its address.",
  frameNotExpanded: "This tool extends the picture: upload the padded picture and the mask of its new area with begin_upload (destination detached) and pass both in expand.",
  promptMissing: "This tool needs a prompt.",
};

/** What a model tool's run is judged on. */
interface ToolRunInput {
  spec: ModelToolSpec;
  /** The tool's model's catalog entry. */
  entry: Parameters<typeof promptRequired>[1];
  source: MiniToolSourceInfo;
  draft: Readonly<Record<string, unknown>>;
  slots: MiniToolSlots;
  prompt: string;
  /** Whether a mask or a sketch was uploaded. */
  drawn: boolean;
  /** Whether the padded picture and its mask were uploaded. */
  expanded: boolean;
}

/**
 * Why a model tool's run is held back, in the order the panel asks.
 * @param input - The tool, its model, what the run carries and the source.
 * @returns The reason, or null when it may run.
 */
function toolRefusal(input: ToolRunInput): ToolRefusalReason | null {
  const { spec, entry, source, slots } = input;
  if (source.url === undefined) return "sourceMissing";
  if (spec.params.some((param) => param.sizeTiers !== undefined)) {
    const choices = sizeTierChoices(spec, entry, input.draft, source);
    if (choices.length === 0) return "sourceMissing";
    if (choices.some((choice) => choice.selected === undefined)) return "noUsableTier";
  }
  for (const slot of spec.slots) if (!slotFilled(slots[slot.key]) && !slotOptional(slot, entry)) return "slotMissing";
  if (slotLengthCap(spec, entry, slots) !== null) return "slotTooLong";
  const limit = sourceLimitOf(spec, entry, source);
  if (limit !== null) return limit.kind === "duration" ? "sourceTooLong" : "sourceTooLarge";
  if (spec.drawing !== undefined && !input.drawn) return "drawingEmpty";
  if (spec.expand !== undefined && !input.expanded) return "frameNotExpanded";
  if (promptRequired(spec, entry) && input.prompt.trim() === "") return "promptMissing";
  return null;
}

export const runMiniTool = defineTool({
  name: "run_mini_tool",
  description:
    "Run one of the node tools that call our models, as its panel's Run does: the result goes into new node(s) placed beside the source and wired from it. Charged to the user's credits. " +
    "Returns the task id and the result node ids at once; the result arrives in finishedTasks, or ask get_task_result. " +
    "Tools that only process the file (crop, rotate, cut, join, speed, convert...) are yours to do on your machine; upload the result with begin_upload. The tools:\n" +
    MODEL_TOOLS.map((spec) => `${spec.id} (on ${spec.source})${spec.prompt === undefined ? "" : ", takes a prompt"}: ${spec.guide}`).join("\n"),
  input: z.object({
    projectId: z.uuid(),
    spaceId: z.uuid(),
    nodeId: z.uuid().describe("The source node."),
    tool: z.string().min(1).describe("The tool's id, from the list above."),
    params: z.record(z.string(), z.json()).optional().describe("The tool's settings, by the names its model takes (list_generation_models); an output size by its label, such as 4K."),
    prompt: z.string().optional().describe("What to make, for a tool that takes a prompt."),
    slots: z.record(z.string(), z.union([z.uuid(), z.array(z.uuid())])).optional().describe("Fill the tool's slots (a voice, a style picture, a character...) from nodes on the canvas, by slot name."),
    mask: z.url().optional().describe("A painting tool's mask: a PNG the size of the source, white where to change, black elsewhere, uploaded with begin_upload."),
    sketch: z.url().optional().describe("A sketch tool's picture: the source with the rough shapes drawn on, uploaded with begin_upload."),
    expand: z.object({ image: z.url(), mask: z.url() }).optional().describe("An extend tool's padded picture and the mask of its new area, uploaded with begin_upload."),
  }),
  readOnly: false,
  run: async (deps, args) => {
    const spec = miniToolById(args.tool);
    if (spec === undefined || !isModelTool(spec)) {
      throw new ToolRefusal("invalid_request", `"${args.tool}" is not one of the tools that call our models; a tool that only processes the file is yours to do on your machine.`);
    }
    const where = { projectId: args.projectId, spaceId: args.spaceId };
    const slotIds = Object.values(args.slots ?? {}).flat();
    const [read, catalog] = await Promise.all([
      runCommandNow(deps, { type: "read_canvas", ...where, params: { nodeIds: [args.nodeId, ...slotIds] } }) as Promise<{ nodes: CanvasNodeView[] }>,
      deps.api.get<ModelCatalog>("/models"),
    ]);
    const byId = new Map(read.nodes.map((node) => [node.id, node]));
    const sourceNode = byId.get(args.nodeId);
    if (sourceNode?.type !== spec.source) throw new ToolRefusal("invalid_request", `${spec.id} runs on a ${spec.source} node.`);
    const media = sourceNode.data as MediaData;
    const source: MiniToolSourceInfo = {
      url: typeof media.content === "string" && media.content !== "" ? media.content : undefined,
      width: media.width,
      height: media.height,
      duration: media.duration,
      sizeBytes: media.sizeBytes,
    };
    const slots: Record<string, MiniToolSlotValue | MiniToolSlotValue[] | undefined> = {};
    for (const [key, picked] of Object.entries(args.slots ?? {})) {
      const values = (Array.isArray(picked) ? picked : [picked]).map((id) => {
        const node = byId.get(id);
        return node ? pickOf(node) : undefined;
      });
      if (values.some((value) => value === undefined)) throw new ToolRefusal("not_found", `A node named for the slot "${key}" holds no file or is not on the canvas.`);
      slots[key] = Array.isArray(picked) ? (values as MiniToolSlotValue[]) : values[0];
    }
    const entry = Object.values(catalog).flatMap((bucket) => (Array.isArray(bucket) ? bucket : [])).find((one) => one.name === modelOf(spec));
    const draft = args.params ?? {};
    const prompt = args.prompt ?? "";
    const refused = toolRefusal({ spec, entry, source, draft, slots, prompt, drawn: args.mask !== undefined || args.sketch !== undefined, expanded: args.expand !== undefined });
    if (refused !== null) throw new ToolRefusal(refused, TOOL_REFUSAL_TEXT[refused]);
    const params = modelToolParams(spec, entry, draft, sizeTierChoices(spec, entry, draft, source), slots);
    const { nodeIds } = (await runCommandNow(deps, { type: "create_mini_tool_results", ...where, params: { toolId: spec.id, sourceNodeId: args.nodeId, params: params as Record<string, never> } })) as { nodeIds: string[] };
    const drawing = args.mask !== undefined ? { mask: args.mask } : args.sketch !== undefined ? { image: args.sketch } : undefined;
    const body = miniToolRequestOf({
      spec,
      projectId: args.projectId,
      spaceId: args.spaceId,
      nodeIds,
      snapshot: { params, prompt, source: { url: source.url!, ...(source.duration === undefined ? {} : { duration: source.duration }) }, slots },
      source: { mimeType: media.mimeType, width: media.width, height: media.height },
      uploads: { ...(drawing ? { drawing } : {}), ...(args.expand ? { expand: args.expand } : {}) },
    });
    const started = await deps.api.post<StartedTask>("/mini-tools", body, { idempotencyKey: idempotencyKey() });
    await deps.tasks.track(started.task_id, "run_mini_tool");
    return { value: { taskId: started.task_id, nodeIds } };
  },
});

/** The generation tools. */
export const GENERATION_TOOLS = [runGeneration, runMiniTool, understandNode, transcribeNode];
