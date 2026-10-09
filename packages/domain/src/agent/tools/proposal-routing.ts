// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * How the nodes of a proposal reach one generation (design 5.7).
 *
 * Three facts decide it: the ways the model takes each kind (`waysIn`),
 * whether the canvas lets that kind be wired into the generation
 * (`canConnect`), and what the node holds -- material reaches a slot through
 * fills, everything else by an edge or, where no edge may be drawn, by the
 * reader picking it. `entriesFor` puts the three together, and every refusal
 * that tells the agent how a node goes in says what `waysSentence` makes of
 * that answer.
 */
import {
  canConnect,
  PANEL_EDITOR_PARAM,
  proposalMarkSegments,
  type CanvasProposal,
  type ProposalNode,
} from "@breatic/shared";

import { modelsForMode, waysIn, type ModelInfo, type WayIn, type WayKind } from "@domain/model-catalog/mode-catalog.js";

/** What a node holds, which decides how it may go into a generation. */
export type Holding = "material" | "empty" | "words";

/** One way a node can go into a generation, and how the proposal sends it. */
export interface Entry {
  /** The way, as `waysIn` lists it. */
  way: WayIn;
  /** An edge saying `into`, the generation's fills, or no edge and a note. */
  by: "edge" | "fills" | "unwired";
}

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
export function chosenModelOf(node: ProposalNode): ModelInfo | undefined {
  if (node.role !== "generate" || node.type === "text" || !node.mode || !node.model) return undefined;
  const reachable = modelsForMode(node.type, node.mode);
  return reachable.available ? reachable.models.find((m) => m.name === node.model) : undefined;
}

/**
 * What a node holds.
 * @param node - The node.
 * @returns Material, words, or nothing yet -- an empty source or a generation still to run.
 * @throws {never} Never.
 */
export function holdingOf(node: ProposalNode): Holding {
  if (node.material !== undefined) return "material";
  return node.role === "written" ? "words" : "empty";
}

/**
 * Every way a node of one kind, holding what it holds, goes into a model.
 * @param chosen - The generation's model.
 * @param kind - The node's kind.
 * @param holding - What it holds.
 * @returns Each way, with how the proposal sends the node by it.
 * @throws {never} Never.
 */
export function entriesFor(chosen: ModelInfo, kind: string, holding: Holding): Entry[] {
  const wired = canConnect(kind, chosen.nodeType);
  return (waysIn(chosen).get(kind as WayKind) ?? []).flatMap((way): Entry[] => {
    if (way.mark !== "note") return wired && (holding !== "material" || way.into === "pool") ? [{ way, by: "edge" }] : [];
    if (holding === "material") return [{ way, by: "fills" }];
    return [{ way, by: wired ? "edge" : "unwired" }];
  });
}

/**
 * One entry, as the agent is told to send it.
 * @param entry - The entry.
 * @param generation - The generation's name.
 * @returns The phrase.
 * @throws {never} Never.
 */
function entryPhrase(entry: Entry, generation: string): string {
  const { into } = entry.way;
  if (entry.by === "fills") return `through fills "${into}" on "${generation}", with no edge`;
  if (entry.by === "unwired") return `unwired, with a note saying to pick it into "${into}"`;
  if (entry.way.mark === "ref") return `by an edge with into: "pool" and a ref @'ing it`;
  if (into === PANEL_EDITOR_PARAM) return `by an edge with into: "${into}", which landing @s into that box`;
  return `by an edge with into: "${into}" and a note saying to pick it there`;
}

/**
 * How a node goes into a generation, said for the agent.
 * @param subject - The node, as the sentence names it.
 * @param generation - The generation it goes into.
 * @param kind - The node's kind.
 * @param entries - Its entries, from `entriesFor`.
 * @returns The sentence.
 * @throws {never} Never.
 */
export function waysSentence(subject: string, generation: ProposalNode, kind: string, entries: readonly Entry[]): string {
  const model = generation.model ?? generation.name;
  if (entries.length === 0) return `"${model}" takes no ${kind} node, so ${subject} has no way into "${generation.name}".`;
  return `${subject} goes into "${generation.name}" ${entries.map((entry) => entryPhrase(entry, generation.name)).join(", or ")}.`;
}

/**
 * How one named node goes into a generation, said for the agent.
 * @param node - The node.
 * @param generation - The generation.
 * @param chosen - The generation's model.
 * @returns The sentence.
 * @throws {never} Never.
 */
export function nodeWaysSentence(node: ProposalNode, generation: ProposalNode, chosen: ModelInfo): string {
  return waysSentence(`"${node.name}"`, generation, node.type, entriesFor(chosen, node.type, holdingOf(node)));
}

/**
 * How nodes of one kind reach one way of a model, said for the agent: once
 * for a node holding material and once for one standing empty, or once for
 * words.
 * @param chosen - The model.
 * @param generation - The generation node.
 * @param kind - The kind the way takes.
 * @param into - The way.
 * @returns The sentences.
 * @throws {never} Never.
 */
export function slotSentence(chosen: ModelInfo, generation: ProposalNode, kind: string, into: string): string {
  const subjects: ReadonlyArray<[Holding, string]> = kind === "text"
    ? [["words", "A written text node"]]
    : [["material", `A ${kind} node holding material`], ["empty", `An empty ${kind} node`]];
  return subjects
    .map(([holding, subject]) => [subject, entriesFor(chosen, kind, holding).filter((entry) => entry.way.into === into)] as const)
    .filter(([, entries]) => entries.length > 0)
    .map(([subject, entries]) => waysSentence(subject, generation, kind, entries))
    .join(" ");
}

/**
 * The refusal for a value set on a box the reader writes in on the panel.
 * @param chosen - The model.
 * @param generation - The generation node.
 * @param key - The box's parameter.
 * @returns The reason.
 * @throws {never} Never.
 */
export function boxReason(chosen: ModelInfo, generation: ProposalNode, key: string): string {
  const reached = slotSentence(chosen, generation, "text", key);
  return reached === ""
    ? `The panel draws no box for "${key}" here, so nothing set for it reaches the model. Leave it out.`
    : `"${key}" is written in a box of its own on the panel, and nothing set here reaches it. Leave it out. ${reached} Or add a note saying what to write in that box.`;
}

/** A node wired into a generation, and the way it goes in. */
export interface Routed {
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
 * @returns Each routed node, or the refusal for the first edge that says no way the model has.
 * @throws {never} Never.
 */
export function routeEdges(
  proposal: CanvasProposal,
  index: number,
  chosen: ModelInfo,
): { routed: Routed[] } | { reason: string } {
  const generation = proposal.nodes[index] as ProposalNode;
  const ways = waysIn(chosen);
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
    if (way === undefined) {
      const said = edge.into === undefined
        ? `The edge from "${from.name}" says no into, and "${chosen.name}" takes a ${from.type} node more than one way.`
        : `"${chosen.name}" takes no ${from.type} by "${edge.into}".`;
      return { reason: `${said} ${nodeWaysSentence(from, generation, chosen)}` };
    }
    // Material reaches a slot through fills, which leaves the snapshot a pick
    // would; an edge into a slot asks the reader to pick a node that is already
    // what goes there.
    if (from.material !== undefined && way.mark === "note") {
      return { reason: `"${from.name}" holds material, so it takes no edge into "${way.into}". ${nodeWaysSentence(from, generation, chosen)}` };
    }
    routed.push({ node: from, way });
  }
  return { routed };
}

/** A material node a generation fills one of its slots with. */
export interface Filled {
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
 * @returns Each filled node with its slot, or the refusal.
 * @throws {never} Never.
 */
export function fillsOf(
  proposal: CanvasProposal,
  node: ProposalNode,
  chosen: ModelInfo,
): { filled: Filled[] } | { reason: string } {
  const ways = waysIn(chosen);
  const slots = [...ways.values()].flat().filter((way) => way.mark === "note");
  const filled: Filled[] = [];
  for (const [param, indices] of Object.entries(node.fills ?? {})) {
    const outside = indices.find((at) => proposal.nodes[at] === undefined);
    if (outside !== undefined) {
      return { reason: `fills "${param}" on "${node.name}" points at node ${String(outside)}, which is not in the group.` };
    }
    const named = indices.map((at) => proposal.nodes[at] as ProposalNode);
    const told = named.map((from) => nodeWaysSentence(from, node, chosen)).join(" ");
    const way = slots.find((option) => option.into === param);
    if (way === undefined) {
      const which = chosen.params[param]?.fromReferencePool === true
        ? `"${param}" is the reference pool of "${chosen.name}", which takes no fills.`
        : `"${chosen.name}" has no slot "${param}".`;
      return { reason: `${which} ${told}` };
    }
    const kind = [...ways.entries()].find(([, list]) => list.includes(way))?.[0];
    const seen = new Set<string>();
    for (const from of named) {
      if (from.material === undefined) {
        return { reason: `fills "${param}" on "${node.name}" points at "${from.name}", which holds no material, and fills takes only nodes holding it. ${nodeWaysSentence(from, node, chosen)}` };
      }
      if (from.type !== kind) {
        return { reason: `"${chosen.name}" takes ${String(kind)} in "${param}", and "${from.name}" is ${from.type}. ${nodeWaysSentence(from, node, chosen)}` };
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
export function notesIn(node: ProposalNode): number {
  return proposalMarkSegments(node).filter((segment) => segment.slot?.kind === "note").length;
}

/**
 * The indices of the nodes one node's prompt and shots @, once per ref.
 * @param node - The node.
 * @returns Each ref's index, in order.
 * @throws {never} Never.
 */
export function refsIn(node: ProposalNode): number[] {
  return proposalMarkSegments(node).flatMap((segment) => (segment.ref === undefined ? [] : [segment.ref]));
}

/** A node one generation asks a note for, and why. */
export interface NoteAsked {
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
export function notesAsked(
  proposal: CanvasProposal,
  routed: readonly Routed[],
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
