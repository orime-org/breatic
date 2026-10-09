// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Propose a wired group of nodes for the reader to place (#229).
 *
 * The tool hands its input straight back: the card the reader presses is
 * drawn from it, and the placing happens on the canvas. What stands between a
 * careless proposal and that card is `checkProposal`, and every rule it
 * applies is read off the live catalog -- which modes a node offers, which
 * models a mode can reach, and whether that mode needs material only the
 * reader has.
 *
 * A mode that needs material is proposed with an empty node to put it in.
 * Every way a node reaches a generation is read off the catalog (`waysIn`,
 * design 5.7): the reference pool, mentioned in the prompt by a ref; a slot
 * on the panel, which the reader picks it into; or a song model's lyrics box,
 * which landing mentions it in. Each edge says which on `into`.
 *
 * Every character of this tool's description and its field descriptions goes
 * out with every turn of every conversation, and is measured against the same
 * budget the messages are (`payload-size.ts`). The refusals below teach the
 * model at the moment it needs it, so the descriptions say the least that
 * gets a first attempt in the right shape.
 *
 * What this check answers is what the catalog and the product rules settle:
 * this mode exists, this model backs it, this value is one the control
 * offers, these characters fit, this line is one the canvas allows, each node
 * goes a way the model has, and the prompt carries a mark or note for each.
 * Marks are counted, never paired with nodes. How many nodes a shape takes,
 * what they are called and how they are wired is the agent's to decide: a
 * scene has more than one good answer, and a check that picked one of them
 * would be the rules written out in code.
 */
import { tool, type Tool } from "ai";
import { z } from "zod";

import {
  canConnect,
  evaluateExecute,
  GENERATION_TEMPLATES,
  extractPromptText,
  markedSegments,
  markReadsBack,
  GENERATION_NODE_MODES,
  MAX_NODE_NAME_LEN,
  PANEL_EDITOR_PARAM,
  promptPlainText,
  promptTextOf,
  referencePool,
  proposalMarkSegments,
  storyboardSend,
  type CanvasProposal,
  type ControlGate,
  type GenerationNodeType,
  type ProposalAnswer,
  type ProposalNode,
} from "@breatic/shared";

import { expandTemplate, templateSegmentsText } from "@domain/agent/tools/template-expansion.js";
import { materialFacts, type MaterialTable } from "@domain/asset/material-facts.js";
import { GET_PRODUCT_GUIDE, SAVE_IMAGE } from "@domain/agent/tools/tool-names.js";
import {
  modelsForMode,
  waysIn,
  type WayIn,
  type WayKind,
  type ModelInfo,
  type ParamInfo,
} from "@domain/model-catalog/mode-catalog.js";
import { getModelCatalog } from "@domain/model-catalog/model-catalog.js";
import { onStep } from "@domain/model-catalog/param-declaration.js";

const NODE_TYPES = Object.keys(GENERATION_NODE_MODES) as [
  GenerationNodeType,
  ...GenerationNodeType[],
];

/** Whether a proposal holds together, and what is missing when it does not. */
export type ProposalVerdict = { ok: true } | { ok: false; reason: string };

export type { MaterialFacts, MaterialTable } from "@domain/asset/material-facts.js";

/** The node kinds that hold material. */
const MATERIAL_KINDS: ReadonlySet<string> = new Set(["image", "video", "audio"]);

/** The table for a proposal that names no material. */
const NO_MATERIAL: MaterialTable = new Map();

// Every string below that a card puts on screen is trimmed before it is
// measured: one made of spaces passes a length check and then draws a bullet
// with nothing beside it, or a mark naming nothing. The prompt's own text is
// the exception and is left alone -- a segment of one space is how two marks
// are kept apart, and trimming it would run them together.
/** Why a label holding its own closing bracket or a line break is refused: written out, it would not read back. */
const LABEL_BRACKET = "A label may not hold the bracket that closes its mark (} for tweak, ) for note) or a line break.";

const promptSegment = z.union([
  z.object({ text: z.string().min(1) }).strict(),
  z
    .object({
      ref: z
        .number()
        .int()
        .describe(
          "An @ of the node at this index in nodes, written into the prompt for the reader: it lands as the " +
            "same mention they would insert by hand. Use it for every node wired into this node's pool, " +
            "wherever the prompt speaks of it",
        ),
    })
    .strict(),
  z
    .object({
      slot: z.union([
        z
          .object({
            kind: z.literal("tweak").describe("Words only the reader can write"),
            label: z.string().trim().min(1).describe("What to write"),
            note: z
              .string()
              .trim()
              .min(1)
              .describe("The line this puts on the card"),
          })
          .strict()
          .refine(markReadsBack, { message: LABEL_BRACKET }),
        z
          .object({
            kind: z
              .literal("note")
              .describe(
                "How to operate the panel, never sent to the model: which slot to pick a node into, or what " +
                  "to do first with a node the prompt @s that lands empty (put a file in it, or generate it)",
              ),
            label: z.string().trim().min(1).describe("The note, which is also the card's line"),
          })
          .strict()
          .refine(markReadsBack, { message: LABEL_BRACKET }),
      ]),
    })
    .strict(),
]);

const proposalNode = z
  .object({
    role: z
      .enum(["source", "generate", "written"])
      .describe("written holds finished words; source holds material, or stands empty for the reader to fill"),
    type: z.enum([...NODE_TYPES, "text"]),
    name: z
      .string()
      .trim()
      .min(1)
      .max(MAX_NODE_NAME_LEN)
      .describe("What the reader sees on the node"),
    material: z
      .string()
      .url()
      .optional()
      .describe(
        `role source only: the address of material in the user's storage -- a file uploaded in the chat, ` +
          `or a picture saved with ${SAVE_IMAGE}. Leave it out for an empty node`,
      ),
    template: z
      .string()
      .min(1)
      .optional()
      .describe(
        "role generate only: start this node from a template; it fills the mode and " +
          "model you leave out, and its params while you keep its mode and model; " +
          "what you write wins. The prompt is yours to send, rewritten from the template's",
      ),
    mode: z.string().min(1).optional().describe("role generate only"),
    model: z.string().min(1).optional().describe("role generate only"),
    params: z
      .record(z.string(), z.unknown())
      .optional()
      .describe(
        "role generate only. Each value has to be one its control offers. " +
          "Leave out what a wired node, the vendor's list or the panel's own " +
          "box fills",
      ),
    prompt: z
      .array(promptSegment)
      .optional()
      .describe(
        "What to generate, or a written node's words, in the language the reader " +
          "writes in. A ref or a mark is a segment of its own, never typed into a text segment. " +
          "Every node going into the pool gets a ref where the prompt speaks of it, and a note too " +
          "when it lands empty; a node going into a slot by an edge takes a note of its own (a slot " +
          "filled through fills takes none, the lyrics box takes none), and so does " +
          "an empty node no edge sends into a generation (unwired, or wired only as a link to a model that " +
          "takes nothing from it), for the reader to pick into a slot",
      ),
    shots: z
      .array(
        z
          .object({
            prompt: z.array(promptSegment),
            duration: z.number().int().min(1),
          })
          .strict(),
      )
      .min(1)
      .optional()
      .describe(
        "role generate only, in mode multi_shot and nowhere else: each " +
          "shot's own prompt and whole seconds, which add up to the duration. " +
          "The main prompt is not sent then, so leave it out; notes go in a shot too",
      ),
    // Last on purpose. While this sat before mode and model the default model
    // never wrote it: asked to copy an input holding it character for
    // character, it wrote params, prompt and shots in its place, and 62
    // proposals over two real runs that reasoned about filling a slot carried
    // none. Listed last, the same copy came back whole (inner#1315).
    fills: z
      .record(z.string(), z.array(z.number().int()).min(1))
      .optional()
      .describe(
        "role generate only: slots of this model filled straight from nodes holding material, as slot " +
          "name to their indices. No edge and no note for these; the reference pool is never filled here",
      ),
  })
  .strict();

/**
 * What the tool accepts before any of the checks below run.
 *
 * Exported for the test that pins it: what the schema turns away never
 * reaches `checkProposal`, so the two halves of "a proposal the reader can
 * press" are held by one file and read by one test.
 */
export const inputSchema = z
  .object({
    nodes: z
      .array(proposalNode)
      .min(1)
      .describe("The nodes to place"),
    edges: z
      .array(
        z
          .object({
            fromIndex: z.number().int(),
            toIndex: z.number().int(),
            into: z
              .string()
              .min(1)
              .optional()
              .describe(
                "Where the node wired in goes: \"pool\" (a ref each where the prompt @s it), " +
                  "the name of a slot the model has (an empty node the reader picks in the panel; a note each; " +
                  "material fills a slot through fills instead), " +
                  `or "${PANEL_EDITOR_PARAM}" for words @'d into a song model's lyrics box for the reader. Needed ` +
                  "when the model takes that kind more than one way",
              ),
          })
          .strict(),
      )
      .describe("Wiring inside this group; indices point into nodes"),
    modelNote: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe("What this model is for, in a few words; say nothing about credits or run time"),
    rationale: z.string().trim().min(1).describe("Why this shape, in a sentence or two"),
    groupName: z
      .string()
      .trim()
      .min(1)
      .max(MAX_NODE_NAME_LEN)
      .optional()
      .describe("What the group is for; needed once there are two nodes"),
  })
  .strict();

/**
 * The model a generation node names, as the catalog serves it.
 *
 * A node the catalog cannot place -- no mode, no model, a model it does not
 * carry -- has none, and the per-generation check says what is wrong with it
 * in its own words.
 * @param node - The proposed node.
 * @returns The model, or undefined when the node generates nothing the catalog serves.
 * @throws {never} Never.
 */
function chosenModelOf(node: ProposalNode): ModelInfo | undefined {
  if (node.role !== "generate" || node.type === "text" || !node.mode || !node.model) return undefined;
  const reachable = modelsForMode(node.type, node.mode);
  return reachable.available ? reachable.models.find((m) => m.name === node.model) : undefined;
}

/**
 * The same proposal with what the catalog says written onto each node.
 *
 * Done before anything is judged, not after, so a check reading them off the
 * node and a canvas reading them off the same node cannot reach different
 * answers.
 * @param proposal - What the model sent.
 * @returns The proposal as it will be placed.
 * @throws {never} Never.
 */
function withCatalogFacts(proposal: CanvasProposal): CanvasProposal {
  return {
    ...proposal,
    nodes: proposal.nodes.map((node) => {
      const chosen = chosenModelOf(node);
      return chosen === undefined ? node : { ...node, takesPrompt: chosen.takesPrompt };
    }),
  };
}

/**
 * Whether a parameter is one only the reader can fill, in the panel.
 *
 * Exported because two readings turn on it and they have to agree: a value
 * set here is refused, and the fixtures build their proposals to match.
 * Answered differently, a fixture the check would turn away is the thing the
 * cases are written against.
 * @param name - The parameter's name.
 * @param info - What the catalog says about it.
 * @returns True when the reader fills it once the group is placed.
 * @throws {never} Never.
 */
export function theirsToFill(name: string, info: ParamInfo): boolean {
  return info.valuesFrom !== undefined || name === PANEL_EDITOR_PARAM;
}

/**
 * Whether the panel will draw this control for the proposal as it stands.
 *
 * A control can hang on a switch of the same model: the camera wheels appear
 * once the camera is enabled and their values are thrown away until it is, and
 * the lyrics box goes away the moment the track is marked instrumental. The
 * switch is part of the proposal, so whether the reader will see the control is
 * answered here rather than by asking whether the model declares it. A gate on
 * a source is already settled by the projection, which reports a control with
 * no slot behind it as having no control at all.
 * @param chosen - The model the proposal picked, as the catalog projects it.
 * @param params - What the proposal fills in.
 * @param info - What the catalog says about the parameter.
 * @returns True when the reader will have that control in front of them.
 * @throws {never} Never.
 */
function isDrawn(
  chosen: ModelInfo,
  params: Record<string, unknown>,
  info: ParamInfo,
): boolean {
  const gate = info.gate;
  if (gate === undefined) return true;
  const held = params[gate.param];
  return typeof held === "boolean" ? held : chosen.params[gate.param]?.default === true;
}

/** How many values a refusal lists before it falls back to the range and step. */
const LISTED_STEPS = 12;

/**
 * Why a number sits between two steps of its slider, or null when it is on one.
 *
 * The slider only stops on steps, so a value between two is one the panel
 * cannot show and, for a model that rounds, not the one it runs with.
 * @param key - The param name, quoted in the reason.
 * @param value - The number the proposal filled in, already within range.
 * @param info - The param as the catalog projects it.
 * @returns The reason, or null.
 */
function offStepReason(key: string, value: number, info: ParamInfo): string | null {
  const { min, max, step } = info;
  if (min === undefined || max === undefined || step === undefined || step <= 0) return null;
  if (onStep(value, min, step)) return null;
  const count = Math.floor((max - min) / step + 1e-9) + 1;
  const takes =
    count <= LISTED_STEPS
      ? Array.from({ length: count }, (_, i) => Number((min + i * step).toFixed(6))).join(", ")
      : `values from ${String(min)} to ${String(max)}`;
  return `"${key}" moves in steps of ${String(step)} from ${String(min)}, so it takes ${takes}, not ${String(value)}.`;
}

/**
 * Judge the values a proposal filled in against what the model declares.
 *
 * The panel offers a control per parameter and that control is what a reader
 * would have used; a value it would not have offered is one that reaches the
 * upstream unchecked.
 * @param chosen - The model the proposal picked, as the catalog projects it.
 * @param node - The node being judged.
 * @returns Whether every value stands, and which one does not.
 * @throws {never} Never.
 */
function checkParams(chosen: ModelInfo, node: ProposalNode): ProposalVerdict {
  const declared = Object.keys(chosen.params);
  for (const [key, value] of Object.entries(node.params ?? {})) {
    const info = chosen.params[key];
    if (!info) {
      return {
        ok: false,
        reason: `"${chosen.name}" declares no ${key}. It takes: ${declared.join(", ") || "no parameters"}.`,
      };
    }
    if (theirsToFill(key, info)) {
      return {
        ok: false,
        reason: info.valuesFrom !== undefined
          ? `"${key}" is picked from a list only ${info.valuesFrom} holds, so it cannot be written here. Leave it out and add a note saying which one to pick.`
          : `"${key}" is written in a box of its own on the panel, and nothing set here reaches it. Leave it out: send words you wrote as a written text node wired in with into: "${key}", which is @'d into that box for you, or add a note saying what to write in that box.`,
      };
    }
    if (info.filledBySource === true) {
      // Two ways that material arrives, and the sentence names the one this
      // model uses: through the pool an edge carries it, through a slot the
      // reader clicks a node on the canvas. Said the other way round, it
      // sends the model off to wire an edge the panel never reads.
      return {
        ok: false,
        reason: info.fromReferencePool === true
          ? `"${key}" is the reference pool, which a node reaches by an edge with into: "pool". Leave it out.`
          : `"${key}" carries the reader's own material: a node holding it fills the slot through fills, and an empty node goes in by an edge with a note. Leave it out.`,
      };
    }
    if (info.fromStoryboard === true) {
      return {
        ok: false,
        reason: `"${key}" is set by the node's shots. Leave it out of params and give shots.`,
      };
    }
    if (info.noControl === true) {
      return {
        ok: false,
        reason: `The panel draws no control for "${key}", so the reader can neither see it nor change it. Leave it out.`,
      };
    }
    if (!isDrawn(chosen, node.params ?? {}, info)) {
      const gate = info.gate as ControlGate;
      return {
        ok: false,
        reason: `"${key}" only counts while "${gate.param}" is on, and this proposal leaves it off. Set that switch or leave "${key}" out.`,
      };
    }
    const options = info.options ?? [];
    if (options.length > 0 && !options.some((offered) => offered === value)) {
      return {
        ok: false,
        reason: `The control for "${key}" offers ${options.map((o) => JSON.stringify(o)).join(", ")}, not ${JSON.stringify(value)}.`,
      };
    }
    if (info.min === undefined && info.max === undefined) continue;
    if (typeof value !== "number") {
      return { ok: false, reason: `"${key}" takes a number, not ${JSON.stringify(value)}.` };
    }
    if ((info.min !== undefined && value < info.min) || (info.max !== undefined && value > info.max)) {
      return {
        ok: false,
        reason: `"${key}" runs from ${String(info.min ?? "?")} to ${String(info.max ?? "?")}, and this one is ${String(value)}.`,
      };
    }
    const offStep = offStepReason(key, value, info);
    if (offStep !== null) return { ok: false, reason: offStep };
  }
  return { ok: true };
}

/**
 * The refusal for a wired node whose edge does not say a way this model takes.
 * @param from - The wired node.
 * @param model - The model fed.
 * @param options - The ways this model takes its kind.
 * @param into - What the edge said, if anything.
 * @returns The reason, naming every way the model takes.
 * @throws {never} Never.
 */
function wayRefusal(from: ProposalNode, model: string, options: readonly WayIn[], into: string | undefined): string {
  const listed = options.map((option) => `"${option.into}"`).join(" or ");
  return into === undefined
    ? `"${from.name}" can go into "${model}" ${String(options.length)} ways; say which on its edge with into: ${listed}.`
    : `"${model}" takes no ${from.type} by "${into}"; set into on the edge from "${from.name}" to ${listed}.`;
}

/** A node wired into a generation, and the way it goes in. */
interface Routed {
  node: ProposalNode;
  way: WayIn;
}

/**
 * Where each node wired into one generation goes, as its edge says (design
 * 5.7). The agent knows, and the marks it writes are words that name no node,
 * so nothing here can work it out from them.
 * @param proposal - The whole proposal.
 * @param index - The generation's index.
 * @param chosen - Its model.
 * @param ways - Its ways in, as `waysIn` gives them.
 * @returns Each routed node, or the refusal for the first edge that says no way the model has.
 * @throws {never} Never.
 */
function routeEdges(
  proposal: CanvasProposal,
  index: number,
  chosen: ModelInfo,
  ways: Map<WayKind, WayIn[]>,
): { routed: Routed[] } | { reason: string } {
  const routed: Routed[] = [];
  for (const edge of proposal.edges.filter((e) => e.toIndex === index)) {
    const from = proposal.nodes[edge.fromIndex];
    if (!from) continue;
    // A slot of a kind the canvas will not wire in is filled by picking, and
    // the edge itself is refused with the rest of the wiring.
    const options = canConnect(from.type, chosen.nodeType) ? (ways.get(from.type) ?? []) : [];
    // An edge the model takes nothing from still carries the creative link
    // (user 2026-08-13); saying where it goes is a claim the model refutes.
    if (options.length === 0) {
      if (edge.into === undefined) continue;
      return { reason: `"${chosen.name}" takes no ${from.type} node, so the edge from "${from.name}" goes nowhere in it; leave into off that edge, or propose a model that takes it.` };
    }
    const way = edge.into === undefined
      ? options.length === 1 ? options[0] : undefined
      : options.find((option) => option.into === edge.into);
    if (way === undefined) return { reason: wayRefusal(from, chosen.name, options, edge.into) };
    routed.push({ node: from, way });
  }
  return { routed };
}

/** A material node a generation fills one of its slots with. */
interface Filled {
  node: ProposalNode;
  way: WayIn;
}

/**
 * The slots one generation fills straight from material nodes (inner#1315),
 * or the refusal for the first entry that cannot stand.
 *
 * A slot filled this way is what a pick in the panel would leave: a snapshot
 * of the node, with no edge. So it is any way in that is neither the pool,
 * which an edge carries, nor the lyrics box, which holds words.
 * @param proposal - The whole proposal.
 * @param node - The generation.
 * @param chosen - Its model.
 * @param ways - Its ways in, as `waysIn` gives them.
 * @returns Each filled node with its slot, or the refusal.
 * @throws {never} Never.
 */
function fillsOf(
  proposal: CanvasProposal,
  node: ProposalNode,
  chosen: ModelInfo,
  ways: Map<WayKind, WayIn[]>,
): { filled: Filled[] } | { reason: string } {
  const slots = [...ways.values()].flat().filter((way) => way.into !== "pool" && way.into !== PANEL_EDITOR_PARAM);
  const filled: Filled[] = [];
  for (const [param, indices] of Object.entries(node.fills ?? {})) {
    const way = slots.find((option) => option.into === param);
    if (way === undefined) {
      const pool = chosen.params[param]?.fromReferencePool === true;
      return {
        reason: pool
          ? `"${param}" is the reference pool of "${chosen.name}", which a node reaches through an edge with into: "pool", not through fills.`
          : `"${chosen.name}" has no slot "${param}"${slots.length > 0 ? `; its slots are ${slots.map((option) => `"${option.into}"`).join(", ")}` : ""}.`,
      };
    }
    const kind = [...ways].find(([, list]) => list.includes(way))?.[0];
    const seen = new Set<string>();
    for (const at of indices) {
      const from = proposal.nodes[at];
      if (from?.role !== "source" || from.material === undefined) {
        return {
          reason: `fills "${param}" on "${node.name}" points at ${from ? `"${from.name}", which is empty` : `node ${String(at)}, which is not in the group`}. Only a node holding material fills a slot here; an empty node goes in by an edge with into: "${param}" and a note.`,
        };
      }
      if (from.type !== kind) {
        return { reason: `"${chosen.name}" takes ${String(kind)} in "${param}", and "${from.name}" is ${from.type}.` };
      }
      if (seen.has(from.material)) {
        return { reason: `fills "${param}" on "${node.name}" holds the same material twice; the slot keeps one copy of it.` };
      }
      seen.add(from.material);
      filled.push({ node: from, way });
    }
  }
  return { filled };
}

/**
 * How many notes a node carries, in its prompt and every shot.
 * @param node - The node.
 * @returns The count.
 * @throws {never} Never.
 */
function notesIn(node: ProposalNode): number {
  return proposalMarkSegments(node).filter((segment) => segment.slot?.kind === "note").length;
}

/**
 * The indices of the nodes one node's prompt and shots @, once per ref.
 * @param node - The node.
 * @returns Each ref's index, in order.
 * @throws {never} Never.
 */
function refsIn(node: ProposalNode): number[] {
  return proposalMarkSegments(node).flatMap((segment) => (segment.ref === undefined ? [] : [segment.ref]));
}

/** A node one generation asks a note for, and why. */
interface NoteAsked {
  node: ProposalNode;
  why: string;
}

/**
 * The notes one generation needs: one for each node going into a slot, which
 * the reader picks there, and one for each node its prompt mentions that lands empty
 * -- an empty source node to put a file in, or a generation still to run.
 * Every check counting notes reads this, so the two never count differently.
 * @param proposal - The whole proposal.
 * @param routed - The generation's incoming edges, each with the way it takes.
 * @param refs - The indices its prompt mentions.
 * @returns One entry per note asked for.
 * @throws {never} Never.
 */
function notesAsked(
  proposal: CanvasProposal,
  routed: ReadonlyArray<{ node: ProposalNode; way: WayIn }>,
  refs: readonly number[],
): NoteAsked[] {
  const slots = routed
    .filter(({ way }) => way.mark === "note")
    .map(({ node, way }) => ({ node, why: `going into ${way.into}` }));
  const empties = [...new Set(refs)].flatMap((at) => {
    const node = proposal.nodes[at];
    if (!node) return [];
    if (node.role === "generate") return [{ node, why: "@'d, and empty until it is generated" }];
    if (node.role === "source" && node.material === undefined) return [{ node, why: "@'d, and empty until a file is put in it" }];
    return [];
  });
  return [...slots, ...empties];
}

/**
 * Judge one generation node against the catalog and its own group.
 * @param proposal - The whole proposal, for reading the group around it.
 * @param node - The node being judged.
 * @param index - Where it sits, for naming it in a refusal.
 * @returns Whether it stands, and what is missing when it does not.
 * @throws {never} Never.
 */
function checkGenerateNode(
  proposal: CanvasProposal,
  node: ProposalNode,
  index: number,
): ProposalVerdict {
  const { mode, model } = node;
  if (node.type === "text") {
    return {
      ok: false,
      reason: `"${node.name}" is a text node, and nothing is generated into one. Write the words yourself and send it as a written node.`,
    };
  }
  const nodeType: GenerationNodeType = node.type;
  if (!mode || !model) {
    return { ok: false, reason: `Node ${index} generates, so it needs a mode and a model.` };
  }
  // A mode this node never had and a mode no model here backs are the same
  // answer from the reader's side -- it cannot be proposed -- and
  // `modelsForMode` already names what the node does offer instead.
  const reachable = modelsForMode(nodeType, mode);
  if (!reachable.available) {
    return {
      ok: false,
      reason: reachable.offered.length > 0
        ? `No model here backs "${mode}" on a ${nodeType} node. It offers: ${reachable.offered.join(", ")}.`
        : `A ${nodeType} node can generate nothing right now.`,
    };
  }
  const chosen = reachable.models.find((m) => m.name === model);
  if (!chosen) {
    return {
      ok: false,
      reason: `"${model}" does not back "${mode}". Those that do: ${reachable.models.map((m) => m.name).join(", ")}.`,
    };
  }
  const values = checkParams(chosen, node);
  if (!values.ok) return values;

  // Defined in the multi-shot mode alone, for a model that takes shots there.
  const board = chosen.storyboard;
  if (node.shots !== undefined && board === undefined) {
    return {
      ok: false,
      reason: `Shots belong to the multi_shot mode. Propose mode "multi_shot" with a model that takes them, or leave shots out.`,
    };
  }
  if (board !== undefined && node.shots === undefined) {
    return {
      ok: false,
      reason: `In the multi_shot mode the shots are what is generated. Give shots, each with its own prompt and seconds.`,
    };
  }
  // The multi-shot run sends the shots in place of the main prompt, so marks
  // in a main prompt beside them would be counted and priced but never sent.
  if (node.shots !== undefined && (node.prompt?.length ?? 0) > 0) {
    return {
      ok: false,
      reason: `With shots the main prompt is not sent. Put its words and notes into the shots and leave prompt out.`,
    };
  }

  // Every segment that can carry a mark: the main prompt, then each shot.
  const prompt = proposalMarkSegments(node);
  // A model drawing no box mounts no editor and forces the box empty: only a
  // note, which the reader reads on the card and which is never sent, has a
  // place there. Words, a tweak and an @ all need a box.
  if (!chosen.takesPrompt && prompt.some((segment) => segment.slot?.kind !== "note")) {
    return {
      ok: false,
      reason: `"${model}" draws no prompt box, so words, tweak marks and refs written there reach nobody. Keep only notes saying what the reader picks in the panel.`,
    };
  }
  const ways = waysIn(chosen);
  const routing = routeEdges(proposal, index, chosen, ways);
  if ("reason" in routing) return { ok: false, reason: routing.reason };
  const { routed } = routing;
  // Material reaches a slot through fills, which leaves the snapshot a pick
  // would; an edge into a slot asks the reader to pick a node that is already
  // what goes there.
  const wiredMaterial = routed.find(({ node: n, way }) => n.material !== undefined && way.into !== "pool");
  if (wiredMaterial) {
    return {
      ok: false,
      reason: `"${wiredMaterial.node.name}" holds material, so it fills "${wiredMaterial.way.into}" through fills on "${node.name}" rather than by an edge.`,
    };
  }
  const filling = fillsOf(proposal, node, chosen, ways);
  if ("reason" in filling) return { ok: false, reason: filling.reason };
  const arriving = [...routed, ...filling.filled];
  // Over a way's room is said first: the fix there is fewer nodes, and every
  // count below would otherwise ask for a mark or note for a node to remove.
  for (const [kind, list] of ways) {
    for (const option of list) {
      const going = arriving.filter(({ way }) => way === option).map(({ node: n }) => n);
      if (going.length > option.room) {
        return {
          ok: false,
          reason: `"${model}" takes ${String(option.room)} ${kind} node(s) by "${option.into}", and ${String(going.length)} are going that way (${going.map((n) => `"${n.name}"`).join(", ")}).${list.length > 1 ? " Send the rest another way it takes, or send fewer." : " Send fewer."}`,
        };
      }
    }
  }
  // Every node wired into the pool is @'d by a ref, and a ref @s only such a
  // node: the mention lands as one the reader would insert from the pool.
  const pooled = routed.filter(({ way }) => way.mark === "ref").map(({ node: n }) => proposal.nodes.indexOf(n));
  const refs = refsIn(node);
  const stray = refs.find((at) => !pooled.includes(at));
  if (stray !== undefined) {
    const named = proposal.nodes[stray];
    return {
      ok: false,
      reason: `${named ? `"${named.name}"` : `node ${String(stray)}`} is @'d by a ref in "${node.name}" but is not wired into its pool. Wire it in with an edge into: "pool", or leave the ref out.`,
    };
  }
  // Every one at once, so a single retry puts them all in.
  const unmentioned = pooled.filter((at) => !refs.includes(at));
  if (unmentioned.length > 0) {
    const names = unmentioned.map((at) => `"${proposal.nodes[at]?.name ?? ""}"`).join(", ");
    const each = unmentioned.map((at) => `{"ref": ${String(at)}}`).join(", ");
    return {
      ok: false,
      reason: `${names} ${unmentioned.length === 1 ? "is" : "are"} wired into the pool of "${node.name}" but no ref @s ${unmentioned.length === 1 ? "it" : "them"}. Put ${each} where the prompt speaks of ${unmentioned.length === 1 ? "it" : "each"}; a node not @'d is not used.`,
    };
  }
  const asked = notesAsked(proposal, routed, refs);
  const notes = notesIn(node);
  if (notes < asked.length) {
    return {
      ok: false,
      reason: `"${node.name}" needs a note for each of ${asked.map(({ node: n, why }) => `"${n.name}" (${why})`).join(", ")}, and carries ${String(notes)}. Give each one a note: which slot to pick it into, or what to do first with a node that lands empty.`,
    };
  }
  const scripts = pooled.flatMap((at) => {
    const target = proposal.nodes[at];
    return target?.type === "text" ? [target] : [];
  });
  /**
   * What the panel sends in place of one ref, the way it serialises it: a
   * text node's words, and a picture, clip or track as its pool's mention,
   * numbered within its kind in the order the pool lists them.
   * @param at - The index of the node the ref mentions.
   * @returns Its words, or its pool mention.
   * @throws {never} Never.
   */
  const refWords = (at: number): string => {
    const target = proposal.nodes[at];
    if (!target) return "";
    if (target.type === "text") return promptPlainText(target.prompt ?? []);
    const entry = getModelCatalog()[nodeType]?.find((m) => m.name === model);
    const mention = referencePool(entry, mode)[target.type]?.mention;
    if (mention === undefined) return "";
    const n = pooled.filter((i) => proposal.nodes[i]?.type === target.type).indexOf(at);
    return mention.replace("{n}", String(n + 1)).replace("{i}", String(n));
  };
  const shotCap = board?.maxChars;
  if (shotCap !== undefined) {
    const long = scripts.find((n) => [...extractPromptText(promptPlainText(n.prompt ?? []))].length > shotCap);
    if (long) {
      return {
        ok: false,
        reason: `"${long.name}" is longer than the ${String(shotCap)} characters "${model}" takes for one shot, so @'ing it into a shot is refused at Generate. Shorten it, or propose a model that takes it.`,
      };
    }
  }
  // What the panel's own gate would say about the box this proposal fills in,
  // asked with the text the box will hold. A note is left out of it.
  const shots = (node.shots ?? []).map((shot) => ({ text: promptTextOf(shot.prompt, refWords), duration: shot.duration }));
  const totalParam = board?.totalParam;
  const total = totalParam === undefined
    ? undefined
    : Number(node.params?.[totalParam] ?? chosen.params[totalParam]?.default);
  // What goes out as the prompt: the shots written into one, for a model with
  // no field for them, so its length is held to the model's cap.
  const sent = board === undefined
    ? promptTextOf(node.prompt ?? [], refWords)
    : (storyboardSend(board, shots.map((shot) => ({ prompt: shot.text, duration: shot.duration }))).prompt ?? "");
  const verdict = evaluateExecute({
    promptText: sent,
    model,
    nodeExists: true,
    isSubmitting: false,
    promptRequired: chosen.takesPrompt,
    ...(chosen.maxInputChars === undefined ? {} : { maxInputChars: chosen.maxInputChars }),
    ...(node.shots !== undefined && total !== undefined
      ? {
          storyboard: {
            shots,
            total,
            ...(board === undefined ? {} : { maxShots: board.maxShots }),
            ...(shotCap === undefined ? {} : { maxChars: shotCap }),
          },
        }
      : {}),
  });
  const storyboardReason = {
    "storyboard-shot-empty": `Shot ${String(verdict?.shot)} writes nothing. Every shot needs its own words.`,
    "storyboard-too-many": `"${model}" takes at most ${String(verdict?.limit)} shots.`,
    "storyboard-shot-too-long": `Shot ${String(verdict?.shot)} is longer than the ${String(verdict?.limit)} characters "${model}" takes for one shot. Shorten it.`,
    "storyboard-duration-mismatch": `The shots add up to ${String(verdict?.seconds?.shots)} seconds and ${String(totalParam)} is ${String(verdict?.seconds?.total)}. Make them match.`,
  } as const;
  if (verdict !== null && verdict.refusal in storyboardReason) {
    return { ok: false, reason: storyboardReason[verdict.refusal as keyof typeof storyboardReason] };
  }
  if (verdict?.refusal === "prompt-missing" || verdict?.refusal === "style-missing") {
    return {
      ok: false,
      reason: `"${model}" generates from what the prompt says, and this proposal writes nothing in it.`,
    };
  }
  if (verdict?.refusal === "prompt-too-long") {
    const written = [...extractPromptText(sent)].length;
    const holding = scripts.map((n) => `"${n.name}"`);
    return {
      ok: false,
      reason: `"${model}" takes ${String(chosen.maxInputChars)} characters and this prompt is ${String(written)}${board === undefined ? "" : " with the shots written into it"}${holding.length > 0 ? `, counting the words in ${holding.join(", ")}` : ""}. Shorten it, or propose a model that takes it.`,
    };
  }

  return { ok: true };
}

/**
 * The refusal for a reference or note on a written node.
 *
 * A text node's body holds words and nothing else: a reference would ask for
 * material nothing here reads, and a note would vanish from words that are
 * kept as written. Said one way wherever it is caught, so a node is never
 * told to send the very segment the next check refuses.
 * @param node - The written node.
 * @returns The refusal.
 * @throws {never} Never.
 */
function writtenTakesNoMark(node: ProposalNode): ProposalVerdict {
  return {
    ok: false,
    reason: `"${node.name}" holds words the reader keeps as they are, so it takes no ref or note. Take it out and say what you meant in your own message.`,
  };
}

/**
 * Whether the material a node names is this studio's, and of the node's kind.
 *
 * An address the registration table does not hold is either somewhere else on
 * the web or not this studio's; both are put right the same way, by saving
 * the picture first.
 * @param node - The node being judged.
 * @param materials - The registration behind each address.
 * @returns Whether it stands, and what is wrong with it when it does not.
 * @throws {never} Never.
 */
function checkMaterial(node: ProposalNode, materials: MaterialTable): ProposalVerdict {
  if (node.material === undefined) return { ok: true };
  if (node.role !== "source" || !MATERIAL_KINDS.has(node.type)) {
    return {
      ok: false,
      reason: `"${node.name}" carries material, which only a source image, video or audio node holds.`,
    };
  }
  const facts = materials.get(node.material);
  if (facts === undefined) {
    return {
      ok: false,
      reason: `"${node.name}" holds an address that is not in our storage. Save a picture found on the web with ${SAVE_IMAGE} first and use the address it answers with.`,
    };
  }
  if (facts === "missing") {
    return {
      ok: false,
      reason: `"${node.name}" holds an address in our storage that does not exist, most likely mistyped. Copy it again exactly as the attachment or the ${SAVE_IMAGE} answer gives it.`,
    };
  }
  if (facts.kind !== node.type) {
    return { ok: false, reason: `"${node.name}" is a ${node.type} node and its material is ${facts.kind}.` };
  }
  return { ok: true };
}

/**
 * Whether one node is the thing its role says it is.
 *
 * The three roles differ in what they carry, not only in what they are called:
 * an empty node holds nothing, a written one holds finished words and so can
 * only be a text node, and a generation is configured. A node whose role and
 * contents disagree lands on the canvas as something the reader cannot use.
 * @param node - The node being judged.
 * @returns Whether it stands, and what is wrong with it when it does not.
 * @throws {never} Never.
 */
function checkNodeRole(node: ProposalNode): ProposalVerdict {
  const configured =
    node.mode !== undefined ||
    node.model !== undefined ||
    node.params !== undefined ||
    node.fills !== undefined ||
    node.shots !== undefined;
  if (node.role === "source") {
    // Words are the one kind of material nobody has to go and find: an empty
    // text node is a click away, so proposing one asks for work rather than
    // saving any. Write the words instead, as a written node.
    if (node.type === "text") {
      return {
        ok: false,
        reason: `"${node.name}" is an empty text node, which the reader makes in one click. Write the words yourself and send it as a written node, or leave it out.`,
      };
    }
    if (configured || node.prompt !== undefined) {
      return {
        ok: false,
        reason: `"${node.name}" is a source node: it holds material or stands empty for the reader, so it takes no mode, model, parameters, fills, shots or prompt.`,
      };
    }
    return { ok: true };
  }
  if (node.role !== "written") return { ok: true };

  if (node.type !== "text") {
    return {
      ok: false,
      reason: `"${node.name}" carries words, and a text node is the only one that holds those.`,
    };
  }
  if (configured) {
    return {
      ok: false,
      reason: `"${node.name}" already holds its words, so it takes no mode, model, fills or shots -- nothing is generated there.`,
    };
  }
  // A text node's body holds words and nothing else: a reference would ask
  // for material nothing here reads, and a note would vanish from words that
  // are kept as written. Whatever they say belongs in the message this
  // proposal travels with.
  const reaching = (node.prompt ?? []).find(
    (segment) => segment.ref !== undefined || segment.slot?.kind === "note",
  );
  if (reaching) return writtenTakesNoMark(node);
  // Without them it lands as an empty text node, which is the thing a reader
  // makes in a click and has no use for in a proposal.
  if (promptPlainText(node.prompt ?? []).trim() === "") {
    return { ok: false, reason: `"${node.name}" says it holds words and carries no words.` };
  }
  return { ok: true };
}

/**
 * Whether a node's words carry a mark typed out as text.
 *
 * Typed, the bracket is words: the reader gets no line on the card for it,
 * the canvas adds nothing to it, and it reaches the model as it stands.
 * @param node - The node being judged.
 * @returns Whether it stands, and the segment to send in its place when not.
 * @throws {never} Never.
 */
function markTypedAsWords(node: ProposalNode): ProposalVerdict {
  // Each prompt is read as one string, so a mark typed across two text
  // segments is caught too. A slot stands in as one character: brackets typed
  // around a mark read back as one mark that swallows it, as they would once
  // written out.
  const typed = [node.prompt ?? [], ...(node.shots ?? []).map((shot) => shot.prompt)].flatMap((segments) =>
    markedSegments(segments.map((segment) => segment.text ?? "\u0000").join("")).flatMap((part) => (part.slot ? [part.slot] : [])),
  );
  if (typed.length === 0) return { ok: true };
  if (node.role === "written" && typed.some((slot) => slot.kind !== "tweak")) return writtenTakesNoMark(node);
  return {
    ok: false,
    reason: `"${node.name}" types ${String(typed.length)} mark(s) into its words. Send each as a segment of its own and keep the text segments to plain words: ${typed.map((slot) => (slot.kind === "asset" ? `{"ref": <index of the node meant by ${slot.label}>}` : JSON.stringify({ slot }))).join(", ")}.`,
  };
}

/**
 * Whether the edges lead anywhere, or run in a circle.
 *
 * An edge stands for one node drawing on another, so a ring of them says every
 * node waits on the next and the reader has nowhere to start.
 * @param proposal - What the model proposed.
 * @returns True when some edge leads back to where it started.
 * @throws {never} Never.
 */
function hasRing(proposal: CanvasProposal): boolean {
  const leadsTo = proposal.nodes.map<number[]>(() => []);
  for (const edge of proposal.edges) leadsTo[edge.fromIndex]?.push(edge.toIndex);
  // 0 not walked, 1 on the path being walked now, 2 walked and left behind.
  const state = proposal.nodes.map(() => 0);
  /**
   * Follow every edge out of one node, looking for the way back to it.
   * @param at - The node to walk from.
   * @returns True when this walk meets a node already on its own path.
   * @throws {never} Never.
   */
  const walk = (at: number): boolean => {
    if (state[at] === 1) return true;
    if (state[at] === 2) return false;
    state[at] = 1;
    for (const next of leadsTo[at] ?? []) {
      if (walk(next)) return true;
    }
    state[at] = 2;
    return false;
  };
  return proposal.nodes.some((_, at) => walk(at));
}

/**
 * Whether a proposal states a flow the reader can carry out.
 *
 * Pure, so the rule it applies is the one a test can hold: the catalog goes
 * in through `modelsForMode`, and nothing else is read.
 *
 * Shape is the model's to decide -- one generation, one empty node feeding
 * three of them, words standing beside them -- within one bound: something
 * here generates. What is asked of every shape is that it states itself: each
 * node is what its role says, each edge stands for one node drawing on
 * another, and a group of two or more says what it is for.
 * @param sent - What the model proposed.
 * @param materials - The registration behind each material address it names;
 *   an address with no entry is not in the user's storage.
 * @returns Whether it stands, and what is missing when it does not.
 * @throws {never} Never.
 */
export function checkProposal(sent: CanvasProposal, materials: MaterialTable = NO_MATERIAL): ProposalVerdict {
  return checkResolved(withCatalogFacts(sent), materials);
}

/**
 * Where the empty nodes a proposal places can go, counted by kind.
 *
 * A proposal cannot see the canvas it lands on, so it cannot know whether the
 * reader already holds a piece of material -- but it can be held to the nodes
 * it places itself. An empty node is a to-do, and a to-do the reader completes
 * and then has nowhere to put is the shape a talking head takes when it is
 * proposed with two portraits: the panel has one place for a picture and one
 * for a voice, so the second portrait can only sit there.
 *
 * Read off the places themselves rather than off the modes table, which speaks
 * in kinds and says nothing about how many places hold each: `first_last` has
 * two places and both take a picture.
 * @param proposal - The proposal being read.
 * @returns How many empty nodes of each kind the group can take.
 * @throws {never} Never.
 */
function placesByKind(proposal: CanvasProposal): Map<string, number> {
  const room = new Map<string, number>();
  for (const node of proposal.nodes) {
    const chosen = chosenModelOf(node);
    if (!chosen) continue;
    for (const [kind, list] of waysIn(chosen)) {
      room.set(kind, (room.get(kind) ?? 0) + list.reduce((sum, way) => sum + way.room, 0));
    }
  }
  return room;
}

/**
 * How a node of a kind the canvas will not wire in still reaches a
 * generation: picked into a slot of that kind in the panel (design 5.7 table A).
 * @param into - The generation the edge was drawn into.
 * @param kind - The kind of the node at the edge's other end.
 * @returns The sentence naming those slots, or nothing where the model has none.
 * @throws {never} Never.
 */
function pickedInstead(into: ProposalNode, kind: string): string {
  const chosen = chosenModelOf(into);
  const slots = chosen ? (waysIn(chosen).get(kind as WayKind) ?? []) : [];
  if (slots.length === 0) return "";
  const names = slots.map((way) => `"${way.into}"`).join(" or ");
  return ` "${into.model}" takes a ${kind} node in its ${names} slot, without an edge: leave this edge off. A node holding material fills it through fills; an empty node is placed unwired with a note saying which slot.`;
}

/**
 * Whether every empty node the proposal places has a place to go.
 *
 * Asked of the group rather than of one generation, because a slot is filled
 * by clicking any node of its kind: an empty node placed beside one generation
 * is as reachable from the next one's panel.
 * @param proposal - The proposal being read.
 * @returns Whether it stands, and which kind is over its room when it does not.
 * @throws {never} Never.
 */
function checkEmptyNodesFit(proposal: CanvasProposal): ProposalVerdict {
  const room = placesByKind(proposal);
  const placed = new Map<string, number>();
  for (const node of proposal.nodes) {
    if (node.role !== "source") continue;
    placed.set(node.type, (placed.get(node.type) ?? 0) + 1);
  }
  for (const [kind, count] of placed) {
    const takes = room.get(kind) ?? 0;
    if (count > takes) {
      return {
        ok: false,
        reason: takes === 0
          ? `This group places ${String(count)} ${kind} source node(s), and nothing in it takes ${kind} material.`
          : `This group places ${String(count)} ${kind} source node(s), and the panels in it hold ${String(takes)} at a time.`,
      };
    }
  }
  return { ok: true };
}

/**
 * Whether every empty node no edge sends into a generation has a note, where
 * some generation in the group has a slot of its kind (design 5.7 table C):
 * unwired, or wired only as a creative link to a model that takes nothing from
 * it. Such a node reaches a generation only by the reader picking it into a
 * slot, and the panel never says which node goes there.
 *
 * Counted over the group, never paired: a slot is filled by clicking any node
 * of its kind, so the notes the group's generations carry beyond those their
 * wired nodes use have to cover every such node.
 * @param proposal - The proposal, its generations already judged.
 * @returns Whether it stands, and which nodes lack a note when it does not.
 * @throws {never} Never.
 */
function checkUnsentNotes(proposal: CanvasProposal): ProposalVerdict {
  const sent = new Set<ProposalNode>();
  const slotKinds = new Set<string>();
  let spare = 0;
  for (const [index, node] of proposal.nodes.entries()) {
    const chosen = chosenModelOf(node);
    if (!chosen) continue;
    const ways = waysIn(chosen);
    for (const [kind, list] of ways) {
      if (list.some((way) => way.into !== "pool")) slotKinds.add(kind);
    }
    // Every generation passed checkGenerateNode, so its edges route.
    const routing = routeEdges(proposal, index, chosen, ways);
    if ("reason" in routing) continue;
    for (const { node: from } of routing.routed) sent.add(from);
    for (const at of Object.values(node.fills ?? {}).flat()) {
      const from = proposal.nodes[at];
      if (from) sent.add(from);
    }
    const refs = refsIn(node);
    spare += notesIn(node) - notesAsked(proposal, routing.routed, refs).length;
  }
  // Material reaches a generation only through fills or an edge into the
  // pool; held anywhere else it lands beside the work with nothing using it.
  const unused = proposal.nodes.find((node) => node.material !== undefined && !sent.has(node));
  if (unused) {
    return {
      ok: false,
      reason: `"${unused.name}" holds material that nothing here uses. Fill a slot with it through fills on a generation, or wire it in with into: "pool".`,
    };
  }
  const loose = proposal.nodes.filter((node) => node.role === "source" && !sent.has(node) && slotKinds.has(node.type));
  if (loose.length <= spare) return { ok: true };
  return {
    ok: false,
    reason: `${loose.map((n) => `"${n.name}"`).join(", ")} ${loose.length === 1 ? "goes" : "go"} into no generation, so the reader picks ${loose.length === 1 ? "it" : "each"} into a slot in the panel, and the generations here carry ${String(spare)} note(s) beyond those their wired nodes use. Give each one a note saying which slot to pick it into.`,
  };
}

/**
 * The same rules, over a proposal the catalog has already been read onto.
 *
 * Apart from {@link checkProposal} by that one step, so the answer the tool
 * hands back is the thing that was judged rather than a second reading of the
 * catalog taken after the verdict.
 * @param proposal - The proposal, carrying its catalog facts.
 * @param materials - The registration behind each material address.
 * @returns Whether it stands, and what is missing when it does not.
 * @throws {never} Never.
 */
function checkResolved(proposal: CanvasProposal, materials: MaterialTable): ProposalVerdict {
  for (const node of proposal.nodes) {
    const held = checkMaterial(node, materials);
    if (!held.ok) return held;
    const verdict = checkNodeRole(node);
    if (!verdict.ok) return verdict;
    const typed = markTypedAsWords(node);
    if (!typed.ok) return typed;
  }

  // A node earns its place on the canvas one of two ways: something generates
  // there, or it stands in a relation the reader would otherwise have to keep
  // in their head. Words with neither are words, and a reply carries those --
  // the reader reads them, takes them, and asks for another version in the
  // same breath, where placing, pressing and undoing buys them nothing.
  if (!proposal.nodes.some((node) => node.role === "generate")) {
    // The second sentence is about words, so it is said only where there are
    // words to say it about. On a group of empty nodes it would send the
    // model off to write copy nobody asked for.
    const words = proposal.nodes.some((node) => node.role === "written");
    return {
      ok: false,
      reason: words
        ? "Nothing here generates, so this is words the reader can read and take from your message. Write them in your reply instead."
        : "Nothing here generates, so a card placed from this leaves the reader nothing to press. Propose what gets made, or say in your reply what they should do.",
    };
  }

  for (const edge of proposal.edges) {
    const ends = [edge.fromIndex, edge.toIndex];
    if (ends.some((i) => i < 0 || i >= proposal.nodes.length)) {
      return { ok: false, reason: `An edge points outside the group: ${JSON.stringify(edge)}.` };
    }
    if (edge.fromIndex === edge.toIndex) {
      return { ok: false, reason: `An edge loops node ${edge.fromIndex} onto itself.` };
    }
    // An edge is how one node draws on another's material, so it can only end
    // where something reads it. Ending anywhere else, it is drawn on the canvas
    // saying a relation that nothing acts on.
    const into = proposal.nodes[edge.toIndex];
    const outOf = proposal.nodes[edge.fromIndex];
    if (into && into.role !== "generate") {
      return {
        ok: false,
        reason: `An edge flows into "${into.name}", which generates nothing, so nothing there reads what it carries.`,
      };
    }
    // The same whitelist the canvas holds a reader's own drag to. A line they
    // could not draw by hand is one the agent may not draw for them.
    if (into && outOf && !canConnect(outOf.type, into.type)) {
      return {
        ok: false,
        reason: `The canvas does not let a ${outOf.type} node feed a ${into.type} node, by your hand or theirs.${pickedInstead(into, outOf.type)}`,
      };
    }
  }
  if (hasRing(proposal)) {
    return {
      ok: false,
      reason: "Those edges make a ring, and a ring says nothing about what the reader presses first.",
    };
  }

  // Two or more nodes land inside a group, which the reader sees as one thing
  // on a ground of its own. Only the model knows what that thing is for -- it
  // just decided -- so the name comes with the proposal.
  if (proposal.nodes.length > 1 && (proposal.groupName ?? "").trim() === "") {
    return {
      ok: false,
      reason: "Two or more nodes land together in a group, so give the group a name saying what it is for.",
    };
  }

  for (const [index, node] of proposal.nodes.entries()) {
    if (node.role !== "generate") continue;
    const verdict = checkGenerateNode(proposal, node, index);
    if (!verdict.ok) return verdict;
  }

  // Last, because they read every generation's places at once and a node the
  // catalog cannot resolve contributes none: asked before the loop above, a
  // proposal naming a model that does not exist would be answered about its
  // empty nodes rather than about the name it got wrong.
  const fit = checkEmptyNodesFit(proposal);
  return fit.ok ? checkUnsentNotes(proposal) : fit;
}

/**
 * What the tool answers with: the proposal as it will be placed, or a refusal.
 *
 * Exported so a test can read the answer without standing up a tool call:
 * everything below `execute` is this function, and a test that reached it
 * through the SDK would be pinning the SDK's calling convention.
 * Nodes naming a template are expanded first, so the check judges the node
 * that will be placed.
 * @param sent - What the model sent.
 * @param materials - The registration behind each material address it names.
 * @returns The answer the card and the canvas read.
 * @throws {never} Never.
 */
export function answerFor(sent: z.infer<typeof inputSchema>, materials: MaterialTable = NO_MATERIAL): ProposalAnswer {
  const nodes: ProposalNode[] = [];
  for (const node of sent.nodes) {
    if (node.template === undefined) {
      const { template: _none, ...plain } = node;
      nodes.push(plain);
      continue;
    }
    const expanded = expandTemplate({ ...node, template: node.template });
    if (!expanded.ok) return { placed: false, reason: expanded.reason };
    nodes.push(expanded.node);
  }
  const proposal: CanvasProposal = { ...sent, nodes };
  const resolved = withCatalogFacts(proposal);
  const verdict = checkResolved(resolved, materials);
  if (!verdict.ok) return { placed: false, reason: verdict.reason };
  // The same resolution the check just judged against, so what the canvas
  // places is the thing that was judged. Asked again over there the catalog
  // could be absent -- the reader may press Use before it loads. Each node
  // holding material carries the numbers its registration holds, so it lands
  // the way an upload would.
  return {
    ...resolved,
    nodes: resolved.nodes.map((node) => {
      const facts = node.material === undefined ? undefined : materials.get(node.material);
      return facts === undefined || facts === "missing" ? node : { ...node, materialMedia: facts.media };
    }),
    placed: true,
  };
}

/**
 * The one line the model reads back.
 *
 * The proposal itself is for the reader, not for the model -- it sent the
 * thing, and repeating it into every later turn costs the whole payload again.
 * @param answer - What the tool answered.
 * @returns A sentence saying it is on screen, or why it is not.
 */
export function renderProposalForModel(answer: ProposalAnswer): string {
  return answer.placed
    ? "The proposal is on screen as a card. The reader decides whether to place it."
    : `That proposal was refused, so nothing is on screen. ${answer.reason}`;
}

/**
 * The templates as the agent reads them: id, what each makes, how many
 * references it takes, and its prompt in the reader's language, so the agent
 * can rewrite that prompt rather than write one from nothing.
 *
 * The prompt is shown as the segments a proposal sends, not as the box shows
 * it: the box adds words to a reference mark, and a model copying what it
 * reads would send those words back inside the label, or a bracket as text.
 * @returns The paragraph appended to the tool's description.
 */
function templateGuide(): string {
  return (
    "Templates a generate node can start from: " +
    GENERATION_TEMPLATES.map((template) => {
      const references = template.references;
      return `${template.id} (${template.nodeType}, ${template.mode}, ${template.model}, ${references} reference${references === 1 ? "" : "s"}): ${template.agentNote}. Its prompt, as segments: ${templateSegmentsText(template)}`;
    }).join("; ") +
    ". Each reference is a node wired in, as with any proposal, its edge saying into: \"pool\", and @'d by its ref. " +
    "Name the template on the node and leave out the mode and model you keep. Send the template's prompt as the " +
    "node's own, rewritten in the language the reader writes in with their story or detail in it: fill a tweak " +
    "segment with words or keep it for them."
  );
}

/** What this tool is handed in its context: the studio whose material counts. */
export interface ProposeContext extends Record<string, unknown> {
  studioId: string;
}

const proposeContextSchema: z.ZodType<ProposeContext> = z.object({ studioId: z.string().min(1) });

/**
 * The proposal tool, built per turn: its description carries the template
 * prompts in the reader's language, which only a turn knows.
 * @returns The tool.
 */
export function makeProposeCanvasAction(): Tool<z.infer<typeof inputSchema>, ProposalAnswer, ProposeContext> {
  return tool({
  description:
    "The canvas is where models are run and where the pieces of one job are " +
    "laid out in relation to each other. Propose the canvas nodes for what " +
    "the reader asked for, as a card they place with one press, and the " +
    "nodes are there, configured and wired. Something has to generate here: " +
    "asked for words and nothing else, write them in your reply instead, " +
    "where they read them and take them. Copy that is one part of a job the " +
    "canvas is doing goes with the rest, held with it in one group, rather " +
    "than half in your reply and half on the canvas. You decide the " +
    "shape: an empty node and a generation for a picture; the copy for the " +
    "same job as a written node beside them; one " +
    "empty node feeding several generations for several takes on one thing. " +
    "A source node can hold material the user gave: a file uploaded in the chat, " +
    `or a picture found on the web and saved with ${SAVE_IMAGE}. Give its address as material, and ` +
    "fill a generation's slot with it through fills, or wire it into the pool. " +
    "Before proposing any shape with an empty node in it, ask_user once " +
    "whether they have that material -- you cannot see their canvas, and the " +
    "answer decides the shape. Wire an edge where a node draws on another's " +
    "work or on what the reader puts in an empty node; belonging is said by " +
    "the group, not edges. " +
    "Ask get_canvas_capabilities and list_generation_models first, and " +
    "propose only a mode and model they returned. Fill in every setting you " +
    "can judge; the rest is theirs to run. Say in your reply, in numbered " +
    `steps written from what ${GET_PRODUCT_GUIDE} says, what they do once it ` +
    "is placed -- what to put in, what to pick, what to press. " +
    templateGuide(),
  inputSchema,
  contextSchema: proposeContextSchema,
  metadata: { runningLine: "chat.tool.proposingNodes" },
  toModelOutput: ({ output }) => ({ type: "text", value: renderProposalForModel(output) }),
  execute: async (
    proposal: z.infer<typeof inputSchema>,
    // The signal is unused: a cached catalog and at most a few ledger rows,
    // so there is nothing worth abandoning. Declared so every tool has the
    // same shape.
    { context }: { abortSignal?: AbortSignal; context?: ProposeContext },
  ): Promise<ProposalAnswer> => {
    const urls = proposal.nodes.flatMap((node) => (node.material === undefined ? [] : [node.material]));
    // A proposal with no material asks the ledger nothing.
    const materials = urls.length === 0 || context === undefined ? NO_MATERIAL : await materialFacts(context.studioId, urls);
    return answerFor(proposal, materials);
  },
});
}
