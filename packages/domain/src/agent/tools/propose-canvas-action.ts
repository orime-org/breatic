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
 * A mode that needs material is proposed with a source node for it: one
 * holding the reader's material (a chat upload or a picture saved with
 * save_image), or an empty one for the reader to fill.
 * Every way a node reaches a generation is read off the catalog (`waysIn`,
 * design 5.7): the reference pool, mentioned in the prompt by a ref; a slot
 * on the panel, which the reader picks it into; or a song model's lyrics box,
 * which landing mentions it in. Each edge says which on `into`.
 *
 * Every character of this tool's description and its field descriptions goes
 * out with every turn of every conversation, and counts toward the request a
 * fold is sized with (`payload-size.ts`) and the window the provider checks. The descriptions carry the
 * rules a first attempt needs to take the right shape; a refusal below says
 * what is wrong, the rule it breaks and the facts of the proposal (design
 * 5.10), and the agent puts the proposal right from that.
 *
 * What this check answers is what the catalog and the product rules settle:
 * this mode exists, this model backs it, this value is one the control
 * offers, these characters fit, this line is one the canvas allows, each node
 * goes a way the model has, and the prompt carries a ref or note for each:
 * each node in the pool is @'d by a ref naming its index, and notes are
 * counted, never paired with nodes. How many nodes a shape takes,
 * what they are called and how they are wired is the agent's to decide: a
 * scene has more than one good answer, and a check that picked one of them
 * would be the rules written out in code.
 */
import { tool, type Tool } from "ai";
import { z } from "zod";

import {
  canConnect,
  GENERATION_TEMPLATES,
  t,
  templateAnchor,
  templateGuideNode,
  type CanvasProposal,
  type GenerationTemplate,
  type ProposalAnswer,
  type ProposalNode,
} from "@breatic/shared";

import { checkGenerateNode } from "@domain/agent/tools/proposal-generate-check.js";
import { checkSourceNodesFit, checkUnsentNotes, hasRing } from "@domain/agent/tools/proposal-group-checks.js";
import { inputSchema, type ProposalVerdict } from "@domain/agent/tools/proposal-input.js";
import { checkMaterial, checkNodeRole, markTypedAsWords } from "@domain/agent/tools/proposal-node-checks.js";
import { fixEdges, fixGroup, nodeLabel, refuse, type NodeLabel, type Refusal } from "@domain/agent/tools/proposal-refusals.js";
import { aNode, chosenModelOf, routeEdges, spaced, waysOrNone } from "@domain/agent/tools/proposal-routing.js";
import { anchoredInstances, checkTemplateInstances, type AnchoredInstance } from "@domain/agent/tools/template-consistency.js";
import { expandAt, templatePlace, type TemplatePlace } from "@domain/agent/tools/template-expansion.js";
import { GET_GENERATION_TEMPLATE, GET_PRODUCT_GUIDE, SAVE_IMAGE } from "@domain/agent/tools/tool-names.js";
import { materialFacts, type MaterialTable } from "@domain/asset/material-facts.js";

export type { MaterialFacts, MaterialTable } from "@domain/asset/material-facts.js";

/** The table for a proposal that names no material. */
const NO_MATERIAL: MaterialTable = new Map();

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
 * Whether two edges join the same two nodes the same way round.
 * @param a - One edge.
 * @param b - The other.
 * @returns True when both run from the same node to the same node.
 * @throws {never} Never.
 */
function sameEnds(a: CanvasProposal["edges"][number], b: CanvasProposal["edges"][number]): boolean {
  return a.fromIndex === b.fromIndex && a.toIndex === b.toIndex;
}

/**
 * Every edge the proposal sends the same way as this one, itself included.
 * @param proposal - The proposal.
 * @param edge - The edge.
 * @returns The edges.
 * @throws {never} Never.
 */
function edgesBetween(proposal: CanvasProposal, edge: CanvasProposal["edges"][number]): CanvasProposal["edges"] {
  return proposal.edges.filter((e) => sameEnds(e, edge));
}

/**
 * The edges between two nodes, said for the agent: how many, and each one's into.
 * @param edges - The edges, all between the same two nodes.
 * @param from - The node they run from.
 * @param to - The node they run to, or the node itself.
 * @returns The phrase.
 * @throws {never} Never.
 */
function edgesSaid(edges: CanvasProposal["edges"], from: NodeLabel, to: NodeLabel | "itself"): string {
  const intos = edges.map((e) => (e.into === undefined ? "no into" : `into "${e.into}"`)).join(", ");
  return `${edges.length > 1 ? `${String(edges.length)} edges run` : "An edge runs"} from ${from} to ${to} (${intos})`;
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
  return checkResolved(withCatalogFacts(sent), materials, []);
}

/**
 * The same rules, over a proposal the catalog has already been read onto.
 *
 * Apart from {@link checkProposal} by that one step, so the answer the tool
 * hands back is the thing that was judged rather than a second reading of the
 * catalog taken after the verdict.
 * @param proposal - The proposal, carrying its catalog facts.
 * @param materials - The registration behind each material address.
 * @param instances - Each template anchored in it, with what its match found.
 * @returns Whether it stands, and what is missing when it does not.
 * @throws {never} Never.
 */
function checkResolved(proposal: CanvasProposal, materials: MaterialTable, instances: readonly AnchoredInstance[]): ProposalVerdict {
  for (const [index, node] of proposal.nodes.entries()) {
    const at = nodeLabel(proposal.nodes, index);
    const held = checkMaterial(node, at, materials);
    if (!held.ok) return held;
    const verdict = checkNodeRole(node, at);
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
    return words
      ? refuse("nothing-generates-words", "Nothing here generates, so these are words the reader reads and takes from your message: words with nothing generating belong in your reply.")
      : refuse("nothing-generates", "Nothing here generates, so a card placed from this leaves the reader nothing to press.");
  }

  // The canvas holds one edge between two nodes: a second drag between the
  // same two lands on the first.
  const pairs = new Set<string>();
  for (const edge of proposal.edges) {
    const ends = [edge.fromIndex, edge.toIndex];
    // An edge is named by its two ends, and every fix takes every edge between them.
    const between = edgesBetween(proposal, edge);
    const from = nodeLabel(proposal.nodes, edge.fromIndex);
    const to = nodeLabel(proposal.nodes, edge.toIndex);
    if (ends.some((i) => proposal.nodes[i] === undefined)) {
      return refuse("edge-outside", `${edgesSaid(between, from, to)}.`, fixEdges(from, to));
    }
    if (edge.fromIndex === edge.toIndex) {
      return refuse("edge-self-loop", `${edgesSaid(between, from, "itself")}.`, fixEdges(from, "itself"));
    }
    const pair = `${String(edge.fromIndex)}>${String(edge.toIndex)}`;
    if (pairs.has(pair)) {
      return refuse("edge-repeated", `${edgesSaid(between, from, to)}, and the canvas holds one edge between two nodes.`);
    }
    pairs.add(pair);
    // An edge is how one node draws on another's material, so it can only end
    // where something reads it. Ending anywhere else, it is drawn on the canvas
    // saying a relation that nothing acts on.
    const into = proposal.nodes[edge.toIndex];
    const outOf = proposal.nodes[edge.fromIndex];
    if (into && into.role !== "generate") {
      return refuse("edge-into-nothing-generating", `An edge flows into "${into.name}", which generates nothing, so nothing there reads what it carries.`);
    }
    // The same whitelist the canvas holds a reader's own drag to. A line they
    // could not draw by hand is one the agent may not draw for them.
    if (into && outOf && !canConnect(outOf.type, into.type)) {
      // How the node reaches the generation instead is the model's to say; a
      // generation naming no model the catalog serves has only the canvas rule.
      const chosen = chosenModelOf(into);
      return refuse("edge-not-allowed", `The canvas does not let ${aNode(outOf.type)} feed ${aNode(into.type)}, by your hand or theirs. ${edgesSaid(between, from, to)}.${chosen ? spaced(waysOrNone(outOf, into, chosen)) : ""}`, fixEdges(from, to));
    }
  }
  if (hasRing(proposal)) {
    return refuse("edge-ring", "Those edges make a ring, and a ring says nothing about what the reader presses first.");
  }

  // Two or more nodes land inside a group, which the reader sees as one thing
  // on a ground of its own. Only the model knows what that thing is for -- it
  // just decided -- so the name comes with the proposal.
  if (proposal.nodes.length > 1 && (proposal.groupName ?? "").trim() === "") {
    return refuse("group-unnamed", "Two or more nodes land together in a group, and it has no name.", fixGroup("Give the group a name saying what it is for."));
  }

  // Asked once the edges are known to join real nodes and before any
  // generation is judged: a template edge left out would otherwise be
  // reported as a ref with no edge behind it, whose fix leaves the template
  // still short of that edge.
  const whole = checkTemplateInstances(proposal, instances);
  if (!whole.ok) return whole;

  for (const [index, node] of proposal.nodes.entries()) {
    if (node.role !== "generate") continue;
    const verdict = checkGenerateNode(proposal, node, index);
    if (!verdict.ok) return verdict;
  }

  // Last, because they read every generation's places at once and a node the
  // catalog cannot resolve contributes none: asked before the loop above, a
  // proposal naming a model that does not exist would be answered about its
  // empty nodes rather than about the name it got wrong.
  const fit = checkSourceNodesFit(proposal);
  return fit.ok ? checkUnsentNotes(proposal) : fit;
}

/** The proposal as the check judges it, and where each node stands in a template it names. */
interface Resolved {
  proposal: CanvasProposal;
  instances: AnchoredInstance[];
}

/**
 * The proposal as the check judges it: every node naming a template filled
 * in from it, and the catalog's facts written on, or the refusal a template
 * gives.
 * @param sent - What the model sent.
 * @param templates - The registry the tags are read against.
 * @returns The resolved proposal and its anchored templates, or the refusal.
 * @throws {never} Never.
 */
function resolveSent(sent: z.infer<typeof inputSchema>, templates: readonly GenerationTemplate[]): Resolved | Refusal {
  const nodes: ProposalNode[] = [];
  const places: (TemplatePlace | undefined)[] = [];
  for (const [index, node] of sent.nodes.entries()) {
    const { template: tag, ...plain } = node;
    if (tag === undefined) {
      nodes.push(plain);
      places.push(undefined);
      continue;
    }
    const place = templatePlace(tag, plain, templates);
    if ("ok" in place) return place;
    const expanded = expandAt(place, plain, nodeLabel(sent.nodes, index));
    if (!expanded.ok) return expanded;
    nodes.push(expanded.node);
    places.push(place);
  }
  const proposal = withCatalogFacts({ ...sent, nodes });
  return { proposal, instances: anchoredInstances(proposal, places) };
}

/**
 * Whether what the model sent stands, templates and all.
 * @param sent - What the model sent.
 * @param materials - The registration behind each material address it names.
 * @param templates - The template registry the tags are read against.
 * @returns The verdict, naming the refusal when there is one.
 * @throws {never} Never.
 */
export function verdictFor(
  sent: z.infer<typeof inputSchema>,
  materials: MaterialTable = NO_MATERIAL,
  templates: readonly GenerationTemplate[] = GENERATION_TEMPLATES,
): ProposalVerdict {
  const resolved = resolveSent(sent, templates);
  return "proposal" in resolved ? checkResolved(resolved.proposal, materials, resolved.instances) : resolved;
}

/**
 * Each anchored template's own nodes marked with the key they stand for, so
 * the panel recognises them on the canvas later; the anchor and the inputs
 * carry no mark, as on the canvas.
 * @param nodes - The proposal's nodes.
 * @param instances - Each anchor and its match.
 * @returns The nodes, marked.
 * @throws {never} Never.
 */
function markTemplateNodes(nodes: readonly ProposalNode[], instances: readonly AnchoredInstance[]): ProposalNode[] {
  const marks = new Map<number, ProposalNode["templateNode"]>();
  for (const { place, match } of instances) {
    for (const [key, found] of match.keys) {
      if (found.kind === "one") marks.set(Number(found.node), { template: place.template.id, key });
    }
  }
  return nodes.map((node, index) => {
    const mark = marks.get(index);
    return mark === undefined ? node : { ...node, templateNode: mark };
  });
}

/**
 * The edges with the inputs wired into each generation put in the order the
 * template declares its inputs, so the reference rail, which lists the edges
 * in the order they were drawn, reads the same as a panel apply would.
 * @param edges - The edges, as sent.
 * @param instances - Each anchor and its match.
 * @returns The edges, the inputs' reordered in the places they held.
 * @throws {never} Never.
 */
function orderInputEdges(edges: CanvasProposal["edges"], instances: readonly AnchoredInstance[]): CanvasProposal["edges"] {
  const out = [...edges];
  for (const { anchor, place, match } of instances) {
    const fedTo = new Map<number, Map<number, number>>();
    place.template.inputs.forEach((input, declared) => {
      for (const [fed, node] of match.inputs.get(input.key) ?? []) {
        const to = fed === place.template.anchor ? undefined : match.keys.get(fed);
        const target = to === undefined ? undefined : to.kind === "one" ? Number(to.node) : undefined;
        const at = fed === place.template.anchor ? anchor : target;
        if (at === undefined) continue;
        fedTo.set(at, (fedTo.get(at) ?? new Map<number, number>()).set(Number(node), declared));
      }
    });
    for (const [to, order] of fedTo) {
      const slots = out.flatMap((edge, i) => (edge.toIndex === to && order.has(edge.fromIndex) ? [i] : []));
      const sorted = slots.map((i) => out[i] as CanvasProposal["edges"][number]).sort((a, b) => (order.get(a.fromIndex) ?? 0) - (order.get(b.fromIndex) ?? 0));
      slots.forEach((i, k) => {
        out[i] = sorted[k] as CanvasProposal["edges"][number];
      });
    }
  }
  return out;
}

/**
 * What the tool answers with: the proposal as it will be placed, or a refusal.
 *
 * Exported so a test can read the answer without standing up a tool call:
 * everything below `execute` is this function, and a test that reached it
 * through the SDK would be pinning the SDK's calling convention.
 * Nodes naming a template are expanded first, so the check judges the node
 * that will be placed; a template with steps gets its guide text node after
 * the agent's own nodes, in the reader's language.
 * @param sent - What the model sent.
 * @param materials - The registration behind each material address it names.
 * @param templates - The template registry the tags are read against.
 * @returns The answer the card and the canvas read.
 * @throws {never} Never.
 */
export function answerFor(
  sent: z.infer<typeof inputSchema>,
  materials: MaterialTable = NO_MATERIAL,
  templates: readonly GenerationTemplate[] = GENERATION_TEMPLATES,
): ProposalAnswer {
  const sentResolved = resolveSent(sent, templates);
  if (!("proposal" in sentResolved)) return { placed: false, reason: sentResolved.reason };
  const { proposal: resolved, instances } = sentResolved;
  const verdict = checkResolved(resolved, materials, instances);
  if (!verdict.ok) return { placed: false, reason: verdict.reason };
  const guides = instances.flatMap(({ anchor, place }) => {
    const guide = templateGuideNode(place.template, anchor);
    return guide === undefined ? [] : [guide];
  });
  const nodes = [...markTemplateNodes(resolved.nodes, instances), ...guides];
  const first = instances[0];
  const groupName =
    resolved.groupName ?? (nodes.length > 1 && first !== undefined ? t(`canvas.template.${first.place.template.id}.name`) : undefined);
  const edges = orderInputEdges(resolved.edges, instances);
  // The same resolution the check just judged against, so what the canvas
  // places is the thing that was judged. Asked again over there the catalog
  // could be absent -- the reader may press Use before it loads. Each node
  // holding material carries the numbers its registration holds, so it lands
  // the way an upload would.
  return {
    ...resolved,
    ...(groupName === undefined ? {} : { groupName }),
    // Each edge names the way the check routed it, so landing reads one
    // answer and never resolves an edge left without into a second time.
    edges: edges.map((edge) => {
      const chosen = edge.into === undefined ? chosenModelOf(resolved.nodes[edge.toIndex] as ProposalNode) : undefined;
      const routing = chosen === undefined ? undefined : routeEdges({ ...resolved, edges: [edge] }, edge.toIndex, chosen);
      const way = routing !== undefined && "routed" in routing ? routing.routed[0]?.entry.way : undefined;
      return way === undefined ? edge : { ...edge, into: way.into };
    }),
    nodes: nodes.map((node) => {
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
 * The templates as one line each, what the agent weighs when choosing one:
 * its id, goal and anchor type, what it makes, the words a reader asks for it
 * with and when to offer it unasked (inner#1807). The full text is read with
 * get_generation_template, so a turn carries every template's index but only
 * the prompts of the template it means to propose.
 * @param templates - The registry.
 * @returns The paragraph appended to the tool's description.
 * @throws {never} Never.
 */
function templateIndex(templates: readonly GenerationTemplate[]): string {
  const lines = templates.map(
    (template) =>
      `${template.id} (${template.goal}, makes ${templateAnchor(template).type}): ${template.agentNote}. ` +
      `The reader asks for it with words like: ${template.triggers.asks.join("; ")}. ` +
      `Offer it unasked when: ${template.triggers.offerWhen.join("; ")}.`,
  );
  return (
    `Templates: ${lines.join(" | ")} ` +
    `Before proposing a template, read it with ${GET_GENERATION_TEMPLATE}: it gives the nodes, wiring, inputs and each prompt ` +
    "in the reader's language, and how to send them."
  );
}

/** What this tool is handed in its context: the studio whose material counts. */
export interface ProposeContext extends Record<string, unknown> {
  studioId: string;
}

const proposeContextSchema: z.ZodType<ProposeContext> = z.object({ studioId: z.string().min(1) });

/**
 * The proposal tool over a template registry: its description indexes the
 * registry's templates.
 * @param templates - The template registry it reads.
 * @returns The tool.
 */
export function makeProposeCanvasAction(
  templates: readonly GenerationTemplate[] = GENERATION_TEMPLATES,
): Tool<z.infer<typeof inputSchema>, ProposalAnswer, ProposeContext> {
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
    "Before proposing any shape with an empty node in it, find out whether " +
    "they have that material, since the answer decides the shape: when the " +
    "message carries the canvas they have open, under \"The Space the reader " +
    "has open\", look there first; ask with ask_user when it is not there or no " +
    "canvas came with the message. Wire an edge where a node draws on another's " +
    "work or on what the reader puts in an empty node; belonging is said by " +
    "the group, not edges. " +
    "Ask get_canvas_capabilities and list_generation_models first, and " +
    "propose only a mode and model they returned. Fill in every setting you " +
    "can judge; the rest is theirs to run. Say in your reply, in numbered " +
    `steps written from what ${GET_PRODUCT_GUIDE} says, what they do once it ` +
    "is placed -- what to put in, what to pick, what to press. " +
    templateIndex(templates),
  inputSchema,
  contextSchema: proposeContextSchema,
  metadata: { runningLine: "chat.tool.proposingNodes" },
  toModelOutput: ({ output }) => ({ type: "text", value: renderProposalForModel(output) }),
  execute: async (
    proposal: z.infer<typeof inputSchema>,
    // The signal is unused: a cached catalog and at most a few ledger rows,
    // so there is nothing worth abandoning. Declared so every tool has the
    // same shape.
    { context }: { abortSignal?: AbortSignal; context: ProposeContext },
  ): Promise<ProposalAnswer> => {
    const urls = proposal.nodes.flatMap((node) => (node.material === undefined ? [] : [node.material]));
    // A proposal with no material asks the ledger nothing.
    const materials = urls.length === 0 ? NO_MATERIAL : await materialFacts(context.studioId, urls);
    return answerFor(proposal, materials, templates);
  },
});
}
