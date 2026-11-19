// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The tools that change a canvas (breatic#1488 §7, §8): each sends collab one
 * command, which applies the browser's own rules for the user's edit (locks,
 * running tasks, someone else's note, which nodes may connect, a full Space).
 */

import { GENERATION_NODE_BUCKETS, GENERATION_TEMPLATES, isGenerationNodeType, type AgentCommandParams, type ModelCatalog, type ModelEntry } from "@breatic/shared";
import {
  agentPromptSegments,
  asContentView,
  CREATABLE_NODE_TYPES,
  modelsForModality,
  resolveModeSwitch,
  type CanvasNodeView,
} from "@breatic/shared/canvas-model";
import { z } from "zod";
import { defineTool, outcomeValue, runCommand, runCommandNow, ToolRefusal, type ToolDeps } from "@mcp/tools/kit.js";

const projectId = z.uuid().describe("The Project's id.");
const spaceId = z.uuid().describe("The canvas Space's id.");
const nodeId = z.string().min(1).describe("A node's id, as read_canvas gives it.");
const nodeIds = z.array(nodeId).min(1);
const point = z.object({ x: z.number(), y: z.number() }).describe("A point in canvas coordinates; x grows rightward, y downward.");
const nodeType = z.enum(CREATABLE_NODE_TYPES as unknown as [string, ...string[]]);
const nodeName = z.string().max(200);

/** Mentions written into a prompt: `@[label](node id)`, the node connected into this one as a reference. */
const PROMPT_HELP =
  "Plain text; mention a reference node as @[its name](its node id), the same form read_canvas shows, and only a node connected into this one. " +
  "Words in {✏️ ...} stay as words to fill; (💡 ...) is a note.";

export const createCanvasNodes = defineTool({
  name: "create_canvas_nodes",
  description:
    "Create nodes (text, image, audio, video) on a canvas, as dragging them from the node library does, with edges between them or to nodes already there, and optionally a new group around them and named existing nodes. " +
    "A node with no position is placed where the user is looking on this canvas (their view or pointer), else beside what the canvas holds, moved right until it covers nothing. " +
    "Returns the new node ids (and edge and group ids). Fill a node with a file through begin_upload, set its prompt and model with update_canvas_node. " +
    "Or give template instead of nodes: a generation template (list_generation_templates) is applied as picking it in the generate panel does, on nodeId (a node of the template's anchor type) or on a new node placed where new nodes go; " +
    "its nodes, edges, models, settings and prompts are written and its resource files fetched in. Returns every node of the flow, the anchor first; toFill says the user is left an empty node to fill or words in {✏️ ...} to write.",
  input: z
    .object({
      projectId,
      spaceId,
      nodes: z
        .array(z.object({ type: nodeType.describe("The node type."), name: nodeName.optional(), position: point.optional() }))
        .min(1)
        .optional()
        .describe("The nodes, in order; edges name them by index."),
      edges: z
        .array(
          z.object({
            source: z.union([z.object({ new: z.number().int().min(0) }).strict(), z.object({ id: nodeId }).strict()]).describe("{ new: index } for a node of this call, { id } for one on the canvas."),
            target: z.union([z.object({ new: z.number().int().min(0) }).strict(), z.object({ id: nodeId }).strict()]),
          }),
        )
        .optional()
        .describe("Connections; a connection into a generate node makes the source one of its references."),
      group: z
        .object({ name: nodeName.optional(), include: z.array(nodeId).optional().describe("Existing nodes to put in the group too.") })
        .optional()
        .describe("Frame the new nodes in a new group."),
      template: z
        .object({ id: z.string().min(1).describe("The template's id."), nodeId: nodeId.optional().describe("Apply it to this node; a new one when left out.") })
        .optional(),
    })
    .refine((args) => (args.template === undefined) !== (args.nodes === undefined), { message: "give either nodes or template" })
    .refine((args) => args.template === undefined || (args.edges === undefined && args.group === undefined), { message: "a template brings its own edges and group" }),
  readOnly: false,
  run: async (deps, { projectId: project, spaceId: space, template, ...params }) => {
    if (template !== undefined) return { value: await applyTemplate(deps, project, space, template) };
    return {
      value: outcomeValue(
        await runCommand(deps, { type: "create_canvas_nodes", projectId: project, spaceId: space, params: params as AgentCommandParams<"create_canvas_nodes"> }),
      ),
    };
  },
});

/**
 * Apply a generation template through collab, then hand its resource nodes
 * to the ingest Worker, as the browser's apply does after the batch.
 * @param deps - The call.
 * @param projectId - The Project.
 * @param spaceId - The canvas Space.
 * @param template - Which template, and the node it applies to.
 * @param template.id - The template's id.
 * @param template.nodeId - The node, or undefined for a new one.
 * @returns The flow's nodes, the group made for them and what is left to the user.
 * @throws {ToolRefusal} When the template is unknown, a model it uses is not served, or collab refuses.
 */
async function applyTemplate(deps: ToolDeps, projectId: string, spaceId: string, template: { id: string; nodeId?: string | undefined }): Promise<Record<string, unknown>> {
  const found = GENERATION_TEMPLATES.find((one) => one.id === template.id);
  if (!found) throw new ToolRefusal("not_found", `No template "${template.id}"; list_generation_templates names them.`);
  const catalog = await deps.api.get<ModelCatalog>("/models");
  const served = new Map(Object.values(catalog).flatMap((bucket) => (Array.isArray(bucket) ? (bucket as ModelEntry[]) : [])).map((entry) => [entry.name, entry]));
  const names = [...new Set(found.nodes.flatMap((node) => (node.role === "generate" ? [node.model] : [])))];
  if (names.some((name) => !served.has(name))) throw new ToolRefusal("model_unavailable", "A model this template uses is not available now.");
  const result = (await runCommandNow(deps, {
    type: "apply_generation_template",
    projectId,
    spaceId,
    params: { templateId: found.id, ...(template.nodeId === undefined ? {} : { nodeId: template.nodeId }), models: names.map((name) => served.get(name)!) as never },
  })) as { nodeIds: string[]; groupId?: string; resources: Array<{ nodeId: string; resource: string }>; toFill: boolean };
  const notFetched: string[] = [];
  for (const { nodeId: node, resource } of result.resources) {
    try {
      await deps.api.post("/canvas/ingest-url", { template_resource: resource, project_id: projectId, space_id: spaceId, node_id: node });
    } catch (err) {
      deps.report(err instanceof Error ? err : new Error(String(err)), { operation: "template_resource_ingest", projectId, nodeId: node });
      notFetched.push(node);
    }
  }
  const { resources: _resources, ...placed } = result;
  return { ...placed, ...(notFetched.length > 0 ? { resourcesNotFetched: notFetched } : {}) };
}

/** What an agent sends to change a node's generation settings. */
const generationInput = z
  .object({
    mode: z.string().min(1).optional().describe("A mode from get_canvas_capabilities. Without a model, the panel's own pick: the model the node used last in that mode, else the mode's first."),
    model: z.string().min(1).optional().describe("A model name from list_generation_models; it must serve the mode."),
    params: z.record(z.string(), z.json()).optional().describe("Parameter values for the node's model, by the names list_generation_models gives."),
    prompt: z.string().optional().describe(`The prompt of the node's current mode. ${PROMPT_HELP}`),
    lyrics: z.string().optional().describe(`An audio node's lyrics. ${PROMPT_HELP}`),
    shots: z
      .array(z.object({ duration: z.number().positive().describe("Seconds."), prompt: z.string().describe(PROMPT_HELP) }))
      .optional()
      .describe("A video node's storyboard shots, replacing the ones it has."),
    slots: z
      .record(z.string(), z.union([nodeId, z.array(nodeId), z.null()]))
      .optional()
      .describe("Fill a reference slot (start frame, end frame, voice sample...) from a node on the canvas, as clicking it in the panel does; null empties it."),
  })
  .refine((change) => Object.values(change).some((value) => value !== undefined), { message: "Name at least one setting to change." })
  .describe("Generation settings to change, as the generation panel changes them.");

/**
 * A model's catalog entry by name.
 * @param deps - The call.
 * @param name - The model's name.
 * @returns Its entry.
 * @throws {ToolRefusal} When the catalog lists no such model.
 */
async function modelEntry(deps: ToolDeps, name: string): Promise<ModelEntry> {
  const catalog = await deps.api.get<ModelCatalog>("/models");
  const entry = Object.values(GENERATION_NODE_BUCKETS)
    .flat()
    .flatMap((bucket) => catalog[bucket])
    .find((one) => one.name === name);
  if (!entry) throw new ToolRefusal("not_found", `No model is named "${name}"; list them with list_generation_models.`);
  return entry;
}

/**
 * The model a node's panel picks when its mode is switched: the one the node
 * remembers for that mode, else the mode's first (`resolveModeSwitch`).
 * @param deps - The call.
 * @param where - The node.
 * @param where.projectId - Its Project.
 * @param where.spaceId - Its Space.
 * @param where.nodeId - The node.
 * @param mode - The mode switched to.
 * @returns The model's name.
 * @throws {ToolRefusal} When the node is not a generate node or no model serves the mode.
 */
async function modelForMode(deps: ToolDeps, where: { projectId: string; spaceId: string; nodeId: string }, mode: string): Promise<string> {
  const [read, catalog] = await Promise.all([
    runCommandNow(deps, { type: "read_canvas", projectId: where.projectId, spaceId: where.spaceId, params: { nodeIds: [where.nodeId] } }) as Promise<{ nodes: CanvasNodeView[] }>,
    deps.api.get<ModelCatalog>("/models"),
  ]);
  const node = read.nodes.find((one) => one.id === where.nodeId);
  if (!node) throw new ToolRefusal("not_found", "The node is not on the canvas.");
  if (!isGenerationNodeType(node.type)) throw new ToolRefusal("invalid_request", "That node does not generate: only image, video and audio nodes have a mode.");
  const { model } = resolveModeSwitch(asContentView(node.data), mode, modelsForModality(catalog, node.type));
  if (model === "") throw new ToolRefusal("invalid_request", `No model serves the mode "${mode}" for this node; see get_canvas_capabilities and list_generation_models.`);
  return model;
}

/**
 * The command's form of a generation change: the model's entry looked up,
 * every prompt's mentions numbered in one list, and a mode switched with no
 * model given the model the panel would pick.
 * @param deps - The call.
 * @param where - The node.
 * @param where.projectId - Its Project.
 * @param where.spaceId - Its Space.
 * @param where.nodeId - The node.
 * @param input - The change as the agent sent it.
 * @returns The change collab takes.
 * @throws {ToolRefusal} When the model is unknown or no model serves the mode.
 */
async function generationChange(
  deps: ToolDeps,
  where: { projectId: string; spaceId: string; nodeId: string },
  input: z.infer<typeof generationInput>,
): Promise<NonNullable<AgentCommandParams<"update_canvas_node">["generation"]>> {
  const model = input.mode !== undefined && input.model === undefined ? await modelForMode(deps, where, input.mode) : input.model;
  let mentions: string[] = [];
  /**
   * One prompt's segments, its mentions added to the shared list.
   * @param text - The prompt.
   * @returns Its segments.
   */
  const segmentsOf = (text: string): ReturnType<typeof agentPromptSegments>["segments"] => {
    const parsed = agentPromptSegments(text, mentions);
    mentions = parsed.mentions;
    return parsed.segments;
  };
  const prompt = input.prompt === undefined ? undefined : segmentsOf(input.prompt);
  const lyrics = input.lyrics === undefined ? undefined : segmentsOf(input.lyrics);
  const shots = input.shots?.map((shot) => ({ duration: shot.duration, prompt: segmentsOf(shot.prompt) }));
  return {
    ...(input.mode === undefined ? {} : { mode: input.mode }),
    ...(model === undefined ? {} : { model, modelEntry: (await modelEntry(deps, model)) as unknown as Record<string, never> }),
    ...(input.params === undefined ? {} : { params: input.params }),
    ...(prompt === undefined ? {} : { prompt }),
    ...(lyrics === undefined ? {} : { lyrics }),
    ...(shots === undefined ? {} : { shots }),
    mentions,
    ...(input.slots === undefined ? {} : { slots: input.slots }),
  } as NonNullable<AgentCommandParams<"update_canvas_node">["generation"]>;
}

export const updateCanvasNode = defineTool({
  name: "update_canvas_node",
  description:
    "Change one node as a user does in the node and its generation panel: rename it, move it, put it in or take it out of a group (parentId, null for none), rewrite a text node's text, " +
    "and change a generate node's settings (mode and model, parameters, prompt, lyrics, storyboard shots, reference slots). A Group's position moves its members with it. " +
    "Only what you send changes. A locked node refuses everything; a node with a running task can still be edited.",
  input: z.object({
    projectId,
    spaceId,
    nodeId,
    name: nodeName.optional(),
    position: point.optional(),
    parentId: nodeId.nullable().optional().describe("The group to put the node in, or null to take it out."),
    text: z.string().optional().describe("A text node's whole text, replacing what it holds."),
    generation: generationInput.optional(),
  }),
  readOnly: false,
  run: async (deps, { projectId: project, spaceId: space, generation, ...rest }) => {
    const where = { projectId: project, spaceId: space, nodeId: rest.nodeId };
    const params = { ...rest, ...(generation ? { generation: await generationChange(deps, where, generation) } : {}) };
    return { value: outcomeValue(await runCommand(deps, { type: "update_canvas_node", projectId: project, spaceId: space, params })) };
  },
});

export const lockCanvasNodes = defineTool({
  name: "lock_canvas_nodes",
  description: "Lock nodes, as the node menu's Lock does: a locked node cannot be moved, renamed, edited, generated into or deleted until unlocked.",
  input: z.object({ projectId, spaceId, nodeIds }),
  readOnly: false,
  run: async (deps, { projectId: project, spaceId: space, nodeIds: ids }) => ({
    value: outcomeValue(await runCommand(deps, { type: "lock_canvas_nodes", projectId: project, spaceId: space, params: { nodeIds: ids } })),
  }),
});

export const unlockCanvasNodes = defineTool({
  name: "unlock_canvas_nodes",
  description: "Unlock nodes, as the node menu's Unlock does.",
  input: z.object({ projectId, spaceId, nodeIds }),
  readOnly: false,
  run: async (deps, { projectId: project, spaceId: space, nodeIds: ids }) => ({
    value: outcomeValue(await runCommand(deps, { type: "unlock_canvas_nodes", projectId: project, spaceId: space, params: { nodeIds: ids } })),
  }),
});

/** One history row, as `GET /canvas/nodes/:id/history` returns it. */
interface HistoryRow {
  id: string;
  status: "success" | "failed";
  content: string | null;
  thumbnailUrl: string | null;
  mediaWidth: number | null;
  mediaHeight: number | null;
  duration: number | null;
  mimeType: string | null;
  size: number | null;
}

/** Rows asked per history page while looking for one entry. */
const HISTORY_PAGE = 100;

export const restoreNodeVersion = defineTool({
  name: "restore_node_version",
  description:
    "Put a node back to an earlier result from its history, as the history panel's Restore does: the entry's file (and a video's cover) becomes the node's content. " +
    "Only a successful entry with a file can be restored; a locked node refuses it. Find the entry with read_node_history.",
  input: z.object({ projectId, spaceId, nodeId: z.uuid().describe("The node's id."), historyId: z.string().min(1).describe("The history entry's id, from read_node_history.") }),
  readOnly: false,
  run: async (deps, args) => {
    let found: HistoryRow | undefined;
    for (let offset = 0; found === undefined; offset += HISTORY_PAGE) {
      const page = await deps.api.get<{ entries: HistoryRow[]; total: number }>(`/canvas/nodes/${args.nodeId}/history`, {
        project_id: args.projectId,
        status: "success",
        limit: String(HISTORY_PAGE),
        offset: String(offset),
      });
      found = page.entries.find((row) => row.id === args.historyId);
      if (offset + page.entries.length >= page.total || page.entries.length === 0) break;
    }
    if (found?.content == null) throw new ToolRefusal("not_found", "The node's history holds no successful entry with that id; read it with read_node_history.");
    const { content, thumbnailUrl, mediaWidth, mediaHeight, duration, mimeType, size } = found;
    return {
      value: outcomeValue(
        await runCommand(deps, {
          type: "restore_node_version",
          projectId: args.projectId,
          spaceId: args.spaceId,
          params: { nodeId: args.nodeId, entry: { status: "success", content, thumbnailUrl, mediaWidth, mediaHeight, duration, mimeType, size } },
        }),
      ),
    };
  },
});

export const commentOnCanvas = defineTool({
  name: "comment_on_canvas",
  description:
    "Write a comment on a canvas as the user: a new note pinned at a point or on a node, or a reply to an existing note (annotationId). Name exactly one of position, nodeId and annotationId. " +
    "A reply to a thread handed to you answers it: the result says answered: true, and it leaves list_assignments. Text is Markdown.",
  input: z.object({
    projectId,
    spaceId,
    text: z.string().min(1).describe("The comment, Markdown."),
    position: point.optional().describe("Pin a new note here."),
    nodeId: nodeId.optional().describe("Pin a new note on this node."),
    annotationId: nodeId.optional().describe("Reply to this note."),
  }),
  readOnly: false,
  run: async (deps, { projectId: project, spaceId: space, ...params }) => ({
    value: outcomeValue(await runCommand(deps, { type: "comment_on_canvas", projectId: project, spaceId: space, params })),
  }),
});

/** A file a deleted node held that no other node uses, as collab reports it. */
interface DeletedAsset {
  fileUrl: string;
  kind: string;
  nodeId: string;
  spaceId: string;
}

/** Most entries one deletion report takes. */
const DELETED_REPORT_MAX = 100;

/**
 * Report the files a deletion left unused, for the Project's activity, as the browser does after a delete.
 * @param deps - The call.
 * @param project - The Project.
 * @param assets - The files.
 */
export async function reportDeletedAssets(deps: ToolDeps, project: string, assets: readonly DeletedAsset[]): Promise<void> {
  try {
    for (let i = 0; i < assets.length; i += DELETED_REPORT_MAX) {
      await deps.api.post("/assets/deleted", {
        project_id: project,
        entries: assets.slice(i, i + DELETED_REPORT_MAX).map((a) => ({ file_url: a.fileUrl, kind: a.kind, node_id: a.nodeId, space_id: a.spaceId })),
      });
    }
  } catch (err) {
    deps.report(err instanceof Error ? err : new Error(String(err)), { operation: "report_deleted_assets", projectId: project, count: assets.length });
  }
}

export const deleteCanvasNodes = defineTool({
  name: "delete_canvas_nodes",
  description:
    "Delete nodes with their edges, as the browser's Delete does; deleting a group deletes its members. A locked node, a node with a running task and someone else's note are kept, " +
    "and the result lists them with the reason (locked, handling, not_yours); the rest are deleted.",
  input: z.object({ projectId, spaceId, nodeIds }),
  readOnly: false,
  run: async (deps, { projectId: project, spaceId: space, nodeIds: ids }) => {
    const result = (await runCommandNow(deps, { type: "delete_canvas_nodes", projectId: project, spaceId: space, params: { nodeIds: ids } })) as {
      deleted: string[];
      kept: unknown[];
      deletedAssets: DeletedAsset[];
    };
    if (result.deletedAssets.length > 0) await reportDeletedAssets(deps, project, result.deletedAssets);
    return { value: { deleted: result.deleted, kept: result.kept } };
  },
});

export const connectNodes = defineTool({
  name: "connect_nodes",
  description:
    "Connect nodes, as dragging an edge does; the canvas's connection rule applies (get_canvas_capabilities). A connection into a generate node adds the source to its references. Returns the edge ids.",
  input: z.object({ projectId, spaceId, edges: z.array(z.object({ source: nodeId, target: nodeId })).min(1) }),
  readOnly: false,
  run: async (deps, { projectId: project, spaceId: space, edges }) => ({
    value: outcomeValue(await runCommand(deps, { type: "connect_nodes", projectId: project, spaceId: space, params: { edges } })),
  }),
});

export const disconnectNodes = defineTool({
  name: "disconnect_nodes",
  description: "Remove edges by id (read_canvas lists them; an edge's id is source->target).",
  input: z.object({ projectId, spaceId, edgeIds: z.array(z.string().min(1)).min(1) }),
  readOnly: false,
  run: async (deps, { projectId: project, spaceId: space, edgeIds }) => ({
    value: outcomeValue(await runCommand(deps, { type: "disconnect_nodes", projectId: project, spaceId: space, params: { edgeIds } })),
  }),
});

/** The canvas write tools. */
export const CANVAS_TOOLS = [
  createCanvasNodes,
  updateCanvasNode,
  lockCanvasNodes,
  unlockCanvasNodes,
  restoreNodeVersion,
  commentOnCanvas,
  deleteCanvasNodes,
  connectNodes,
  disconnectNodes,
];
