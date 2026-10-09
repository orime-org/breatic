// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * How the nodes of a proposal reach one generation (design 5.7).
 *
 * Three facts decide it: the ways the model takes each kind (`waysIn`),
 * whether the canvas lets that kind be wired into the generation
 * (`canConnect`), and what the node holds -- material reaches a slot through
 * fills, everything else by an edge or, where no edge may be drawn, by the
 * reader picking it. `entriesFor` puts the three together into everything a
 * proposal does to send a node one way: the edge or fills, the ref and the
 * note. The check accepts a node only when it arrives as one of its entries,
 * and every refusal that tells the agent how a node goes in says what
 * `waysSentence` makes of the same entries.
 */
import {
  canConnect,
  proposalMarkSegments,
  type CanvasProposal,
  type ProposalNode,
} from "@breatic/shared";

import { refuse, type Refusal } from "@domain/agent/tools/proposal-refusals.js";
import { modelsForMode, waysIn, type ModelInfo, type WayIn, type WayKind } from "@domain/model-catalog/mode-catalog.js";

/** What a node holds, which decides how it may go into a generation. */
export type Holding = "material" | "empty" | "words";

/** One way a node can go into a generation, and everything the proposal does to send it. */
export interface Entry {
  /** The way, as `waysIn` lists it. */
  way: WayIn;
  /** An edge saying `into`, the generation's fills, or no edge and a note. */
  by: "edge" | "fills" | "unwired";
  /** Whether the generation's prompt mentions the node with a ref. */
  ref: boolean;
  /** Whether the generation's prompt carries a note for the node. */
  note: boolean;
}

/**
 * A node of one kind, with its article.
 * @param kind - The kind.
 * @returns "an image node", "a video node".
 * @throws {never} Never.
 */
export function aNode(kind: string): string {
  return `${/^[aeiou]/.test(kind) ? "an" : "a"} ${kind} node`;
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
    // The pool is @'d by a ref, and a node landing empty there needs a note
    // saying what to put in it or run first.
    if (way.mark === "ref") return wired ? [{ way, by: "edge", ref: true, note: holding === "empty" }] : [];
    // The lyrics box is @'d at landing.
    if (way.mark === "placed") return wired && holding !== "material" ? [{ way, by: "edge", ref: false, note: false }] : [];
    // A slot: material fills it as a pick would; anything else is picked by
    // the reader, whom a note tells which node goes there.
    if (holding === "material") return [{ way, by: "fills", ref: false, note: false }];
    return [{ way, by: wired ? "edge" : "unwired", ref: false, note: true }];
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
  if (entry.by === "fills") return `through fills "${into}" on "${generation}", with no edge and no ref`;
  if (entry.by === "unwired") return `unwired, with a note saying to pick it into "${into}" and no ref`;
  const marks = [
    ...(entry.ref ? ["a ref @'ing it"] : []),
    ...(entry.note ? [entry.ref ? "a note saying what to do first" : "a note saying to pick it there"] : []),
  ];
  // Every edge entry but the lyrics box carries a ref or a note.
  if (marks.length === 0) return `by an edge with into: "${into}", which landing @s into that box, and no ref`;
  return `by an edge with into: "${into}" and ${marks.join(" and ")}${entry.ref ? "" : " and no ref"}`;
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
    : [["material", `${capitalised(aNode(kind))} holding material`], ["empty", `An empty ${kind} node`]];
  return subjects
    .map(([holding, subject]) => [subject, entriesFor(chosen, kind, holding).filter((entry) => entry.way.into === into)] as const)
    .filter(([, entries]) => entries.length > 0)
    .map(([subject, entries]) => waysSentence(subject, generation, kind, entries))
    .join(" ");
}

/**
 * A phrase with its first letter in capitals.
 * @param phrase - The phrase.
 * @returns It, capitalised.
 * @throws {never} Never.
 */
function capitalised(phrase: string): string {
  return phrase.charAt(0).toUpperCase() + phrase.slice(1);
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
  return `"${key}" is written in a box of its own on the panel, and nothing set here reaches it. Leave it out. ${slotSentence(chosen, generation, "text", key)}`;
}

/**
 * Where else in the group a node goes, for the refusal of an edge into a model
 * that takes nothing of its kind. A node generating or holding words can stay
 * wired as a creative link; a source node is there to be used, so it is told
 * which generation here takes it, or to come out.
 * @param proposal - The whole proposal.
 * @param from - The node.
 * @returns The sentence.
 * @throws {never} Never.
 */
function elsewhereSentence(proposal: CanvasProposal, from: ProposalNode): string {
  if (from.role !== "source") return "Leave into off that edge, or propose a model that takes it.";
  const takers = proposal.nodes.flatMap((generation) => {
    const chosen = chosenModelOf(generation);
    return chosen !== undefined && entriesFor(chosen, from.type, holdingOf(from)).length > 0 ? [nodeWaysSentence(from, generation, chosen)] : [];
  });
  return takers.length > 0
    ? `Send it into a generation that takes it: ${takers.join(" ")}`
    : `No generation here takes ${aNode(from.type)}; propose a model that takes it, or take "${from.name}" out.`;
}

/** A node going into a generation, and the entry it arrives by. */
export interface Arriving {
  node: ProposalNode;
  entry: Entry;
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
): { routed: Arriving[] } | Refusal {
  const generation = proposal.nodes[index] as ProposalNode;
  const ways = waysIn(chosen);
  const routed: Arriving[] = [];
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
      return refuse("edge-kind-not-taken", `"${chosen.name}" takes no ${from.type} node, so the edge from "${from.name}" goes nowhere in it. ${elsewhereSentence(proposal, from)}`);
    }
    if (edge.into === undefined && options.length > 1) {
      return refuse("edge-into-ambiguous", `The edge from "${from.name}" says no into, and "${chosen.name}" takes ${aNode(from.type)} more than one way. ${nodeWaysSentence(from, generation, chosen)}`);
    }
    const into = edge.into ?? options[0]?.into;
    // The edge stands only as one of the node's entries: material reaches a
    // slot through fills, which leaves the snapshot a pick would, so an edge
    // into a slot is no entry of a node holding material.
    const entry = entriesFor(chosen, from.type, holdingOf(from)).find((e) => e.by === "edge" && e.way.into === into);
    if (entry === undefined) {
      return refuse("edge-not-an-entry", `"${from.name}" does not go into "${String(into)}" of "${generation.name}" by an edge. ${nodeWaysSentence(from, generation, chosen)}`);
    }
    routed.push({ node: from, entry });
  }
  return { routed };
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
): { filled: Arriving[] } | Refusal {
  const ways = waysIn(chosen);
  const slots = [...ways.values()].flat().filter((way) => way.mark === "note");
  const filled: Arriving[] = [];
  for (const [param, indices] of Object.entries(node.fills ?? {})) {
    const outside = indices.find((at) => proposal.nodes[at] === undefined);
    if (outside !== undefined) {
      return refuse("fill-outside", `fills "${param}" on "${node.name}" points at node ${String(outside)}, which is not in the group.`);
    }
    const named = indices.map((at) => proposal.nodes[at] as ProposalNode);
    if (named.includes(node)) {
      return refuse("fill-self", `fills "${param}" on "${node.name}" points at "${node.name}" itself, and a node cannot fill its own slot. Check the index the fill means.`);
    }
    const told = named.map((from) => nodeWaysSentence(from, node, chosen)).join(" ");
    const way = slots.find((option) => option.into === param);
    if (way === undefined) {
      const which = chosen.params[param]?.fromReferencePool === true
        ? `"${param}" is the reference pool of "${chosen.name}", which takes no fills.`
        : `"${chosen.name}" has no slot "${param}".`;
      return refuse("fill-not-a-slot", `${which} ${told}`);
    }
    const kind = [...ways.entries()].find(([, list]) => list.includes(way))?.[0];
    const seen = new Set<string>();
    for (const from of named) {
      if (from.material === undefined) {
        return refuse("fill-no-material", `fills "${param}" on "${node.name}" points at "${from.name}", which holds no material, and fills takes only nodes holding it. ${nodeWaysSentence(from, node, chosen)}`);
      }
      if (from.type !== kind) {
        return refuse("fill-wrong-kind", `"${chosen.name}" takes ${String(kind)} in "${param}", and "${from.name}" is ${from.type}. ${nodeWaysSentence(from, node, chosen)}`);
      }
      if (seen.has(from.material)) {
        return refuse("fill-twice", `fills "${param}" on "${node.name}" holds the same material twice; the slot keeps one copy of it.`);
      }
      seen.add(from.material);
      filled.push({ node: from, entry: { way, by: "fills", ref: false, note: false } });
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
 * The notes one generation needs: one for each node arriving by an entry that
 * carries a note -- a node going into a slot, which the reader picks there,
 * and a node in the pool that lands empty, an empty source to put a file in or
 * a generation still to run. Every check counting notes reads this, so the
 * two never count differently.
 * @param arriving - The nodes going into the generation, each with its entry.
 * @returns One entry per note asked for.
 * @throws {never} Never.
 */
export function notesAsked(arriving: readonly Arriving[]): NoteAsked[] {
  return arriving
    .filter(({ entry }) => entry.note)
    .map(({ node, entry }) => ({
      node,
      why: entry.ref
        ? node.role === "generate" ? "@'d, and empty until it is generated" : "@'d, and empty until a file is put in it"
        : `going into ${entry.way.into}`,
    }));
}
