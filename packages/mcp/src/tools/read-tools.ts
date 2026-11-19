// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The tools that read (breatic#1488 §7): what the user can open, a Space's
 * content and who is in it, what the canvas allows, the models, voices and
 * templates, and a node's history. Each reads as the user, through the same
 * routes and documents the browser reads.
 */

import {
  CREATABLE_NODE_TYPES,
  type CreatableNodeType,
} from "@breatic/shared/canvas-model";
import {
  GENERATION_NODE_BUCKETS,
  GENERATION_NODE_MODES,
  GENERATION_TEMPLATES,
  canConnect,
  canGenerate,
  isGenerationNodeType,
  t,
  templateAnchor,
  templateNodeWords,
  templatesFor,
  type GenerationTemplate,
  type ModelCatalog,
  type ModelEntry,
} from "@breatic/shared";
import { z } from "zod";
import { namesIn } from "@mcp/tools/names.js";
import { defineTool, outcomeValue, runCommand, ToolRefusal, touchPresence } from "@mcp/tools/kit.js";

const projectId = z.uuid().describe("The Project's id, from list_projects.");
const spaceId = z.uuid().describe("The Space's id, from list_spaces.");
const generationNodeType = z.enum(["image", "video", "audio"]).describe("The generate node's type.");

/** One Studio as `GET /studios` lists it. */
interface StudioRow {
  id: string;
  slug: string;
  name: string;
  myStudioRole: string | null;
}

/** One page of a Studio's Projects. */
interface ProjectPage {
  items: Array<{ id: string; name: string; myRole: string | null; lastEditedAt: string | null }>;
  nextCursor: string | null;
}

export const listProjects = defineTool({
  name: "list_projects",
  description:
    "List the Studios the user belongs to and, in each, every Project they can open (archived ones are left out), with the user's role. " +
    "A Project holds Spaces (canvas, document, 3d, timeline); list them with list_spaces. A viewer can read a Project but not change it.",
  input: z.object({}),
  readOnly: true,
  run: async (deps) => {
    const studios = await deps.api.get<StudioRow[]>("/studios");
    const listed = await Promise.all(
      studios.map(async (studio) => {
        const projects: ProjectPage["items"] = [];
        let cursor: string | undefined;
        do {
          const page = await deps.api.get<ProjectPage>(`/studio/${encodeURIComponent(studio.slug)}/projects`, { cursor });
          projects.push(...page.items);
          cursor = page.nextCursor ?? undefined;
        } while (cursor !== undefined);
        return {
          id: studio.id,
          slug: studio.slug,
          name: studio.name,
          role: studio.myStudioRole,
          projects: projects.map((p) => ({ id: p.id, name: p.name, role: p.myRole, lastEditedAt: p.lastEditedAt })),
        };
      }),
    );
    return { value: { studios: listed } };
  },
});

export const listSpaces = defineTool({
  name: "list_spaces",
  description: "List a Project's Spaces in the order its tab bar shows them: id, type (canvas, document, 3d or timeline) and name.",
  input: z.object({ projectId }),
  readOnly: true,
  run: async (deps, args) => ({ value: outcomeValue(await runCommand(deps, { type: "list_spaces", projectId: args.projectId, spaceId: null, params: {} })) }),
});

export const readCanvas = defineTool({
  name: "read_canvas",
  description:
    "Read a canvas Space: each node's id, type, name, position, size, group (parentId), lock, content (file address or text), generation settings and the prompt with each @-mention written as @[name](node id), task counts; " +
    "the edges; annotation (comment) nodes with their replies, which external agent wrote a reply (via) and which thread is handed to which agent (assignment); " +
    "and the people on this canvas now, with the nodes each has selected and their pointer, the user marked you: true. `names` gives each member's and agent's name by id. " +
    "Without nodeIds a large canvas comes back cut at the read limit, with truncated: true and total; name the nodes you need to read the rest. Read before you change anything.",
  input: z.object({
    projectId,
    spaceId,
    nodeIds: z.array(z.string().min(1)).min(1).optional().describe("Only these nodes, and the edges touching them."),
  }),
  readOnly: true,
  run: async (deps, args) => {
    const outcome = await runCommand(deps, {
      type: "read_canvas",
      projectId: args.projectId,
      spaceId: args.spaceId,
      params: args.nodeIds ? { nodeIds: args.nodeIds } : {},
    });
    if (outcome.kind === "pending") return { value: outcomeValue(outcome) };
    return { value: { ...(outcome.result as Record<string, unknown>), names: await namesIn(deps.api, outcome.result) } };
  },
});

export const getCanvasCapabilities = defineTool({
  name: "get_canvas_capabilities",
  description:
    "What a canvas allows: the node types you can create, whether each generates and in which modes, and which node type may connect into which. " +
    "A connection into a generate node makes the source one of its references. Models for a mode come from list_generation_models.",
  input: z.object({}),
  readOnly: true,
  run: async () => {
    const types: readonly CreatableNodeType[] = CREATABLE_NODE_TYPES;
    return {
      value: {
        nodeTypes: types.map((type) => ({
          type,
          generates: canGenerate(type),
          modes: isGenerationNodeType(type) ? [...GENERATION_NODE_MODES[type]] : [],
        })),
        connections: types.flatMap((from) => types.filter((to) => canConnect(from, to)).map((to) => ({ from, to }))),
      },
    };
  },
});

/**
 * A catalog entry as an agent reads it: what a generation panel shows, without upstream routing.
 * @param entry - The entry.
 * @returns The fields an agent chooses by.
 */
function modelOf(entry: ModelEntry): Record<string, unknown> {
  const { availability: _availability, icon: _icon, ...rest } = entry as ModelEntry & { icon?: unknown };
  return rest;
}

export const listGenerationModels = defineTool({
  name: "list_generation_models",
  description:
    "List the models a generate node can use, as the generation panel lists them: name, modes, description and guide, each parameter with its values and default, " +
    "whether it takes a prompt, typical generation time and pricing rules (credits = rule price x creditMultiplier). Filter by node type and mode.",
  input: z.object({
    nodeType: generationNodeType,
    mode: z.string().min(1).optional().describe("A mode from get_canvas_capabilities, such as t2i or i2v."),
  }),
  readOnly: true,
  run: async (deps, args) => {
    const catalog = await deps.api.get<ModelCatalog>("/models");
    const entries = GENERATION_NODE_BUCKETS[args.nodeType].flatMap((bucket) => catalog[bucket]);
    const models = entries
      .filter((entry) => entry.tier !== "internal")
      .filter((entry) => args.mode === undefined || (Array.isArray(entry.mode) ? entry.mode.includes(args.mode) : entry.mode === args.mode))
      .map(modelOf);
    return { value: { models, creditMultiplier: catalog.credit_multiplier } };
  },
});

export const listVoices = defineTool({
  name: "list_voices",
  description: "List the voices a speech model offers, searched by words in their name or description. An audio node with no voice chosen generates with the first one.",
  input: z.object({
    model: z.string().min(1).describe("The model's name, from list_generation_models."),
    query: z.string().max(200).optional().describe("Words to search for."),
  }),
  readOnly: true,
  run: async (deps, args) => ({ value: await deps.api.get(`/models/${encodeURIComponent(args.model)}/voices`, { query: args.query }) }),
});

/**
 * One of a template's words, in English.
 * @param template - The template.
 * @param rest - The key under its locale entry.
 * @returns The words.
 */
function templateText(template: GenerationTemplate, rest: string): string {
  return t(`canvas.template.${template.id}.${rest}`);
}

export const listGenerationTemplates = defineTool({
  name: "list_generation_templates",
  description:
    "List the generation templates: ready-made node graphs a user starts a flow from in the generation panel (character sheets, storyboards, product shots and more). " +
    "Each has a name, what it makes, its goal, and the generate node it is applied to. Read one with get_generation_template.",
  input: z.object({ nodeType: generationNodeType.optional().describe("Only the templates applied to this node type.") }),
  readOnly: true,
  run: async (_deps, args) => {
    const templates = args.nodeType === undefined ? GENERATION_TEMPLATES : templatesFor(args.nodeType);
    return {
      value: {
        templates: templates.map((template) => {
          const anchor = templateAnchor(template);
          return {
            id: template.id,
            name: templateText(template, "name"),
            description: templateText(template, "description"),
            goal: template.goal,
            anchorType: anchor.type,
            anchorMode: anchor.mode,
            anchorModel: anchor.model,
          };
        }),
      },
    };
  },
});

export const getGenerationTemplate = defineTool({
  name: "get_generation_template",
  description:
    "Read one generation template in full: its nodes (generate nodes with type, mode, model, parameters and their words; resource nodes with the file they hold), " +
    "the edges between them, the inputs the user supplies and which node each feeds, and the steps left to the user after it generates. " +
    "Words in {✏️ ...} are for you to fill in from what the user wants before generating.",
  input: z.object({ id: z.string().min(1).describe("The template's id, from list_generation_templates.") }),
  readOnly: true,
  run: async (_deps, args) => {
    const template = GENERATION_TEMPLATES.find((one) => one.id === args.id);
    if (template === undefined) throw new ToolRefusal("not_found", `No template has the id "${args.id}"; list them with list_generation_templates.`);
    const nodes = template.nodes.map((node) => {
      if (node.role !== "generate") return node;
      const words = templateNodeWords(template, node.key);
      return {
        ...node,
        words:
          "prompt" in words
            ? { prompt: templateText(template, words.prompt) }
            : "shots" in words
              ? { shots: words.shots.map((shot) => ({ seconds: shot.seconds, prompt: templateText(template, shot.key) })) }
              : { lines: words.lines.map((line) => ({ speaker: line.speaker, prompt: templateText(template, line.key) })) },
      };
    });
    return {
      value: {
        id: template.id,
        name: templateText(template, "name"),
        description: templateText(template, "description"),
        goal: template.goal,
        note: template.agentNote,
        anchor: template.anchor,
        nodes,
        edges: template.edges,
        inputs: template.inputs,
        steps: template.steps.map((step) => templateText(template, `step.${step}`)),
      },
    };
  },
});

export const readNodeHistory = defineTool({
  name: "read_node_history",
  description:
    "Read a canvas node's history, newest first, as its history panel shows it: each generation, upload and snapshot with status, result address or error, who ran it and when. " +
    "A successful entry can be put back with restore_node_version.",
  input: z.object({
    projectId,
    nodeId: z.uuid().describe("The node's id."),
    status: z.enum(["success", "failed"]).optional().describe("Only entries with this status."),
    limit: z.number().int().min(1).max(100).optional().describe("Entries per page, 20 when left out."),
    offset: z.number().int().min(0).optional().describe("Entries to skip."),
  }),
  readOnly: true,
  run: async (deps, args) => {
    const [value] = await Promise.all([
      deps.api.get(`/canvas/nodes/${args.nodeId}/history`, {
        project_id: args.projectId,
        status: args.status,
        limit: args.limit === undefined ? undefined : String(args.limit),
        offset: args.offset === undefined ? undefined : String(args.offset),
      }),
      touchPresence(deps, args.projectId, null, [args.nodeId]),
    ]);
    return { value };
  },
});

/** The read tools, in the order an agent meets them. */
export const READ_TOOLS = [
  listProjects,
  listSpaces,
  readCanvas,
  getCanvasCapabilities,
  listGenerationModels,
  listVoices,
  listGenerationTemplates,
  getGenerationTemplate,
  readNodeHistory,
];
