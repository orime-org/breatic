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

import { fixOn, refuse, type NodeLabel, type NodeFix, type Refusal } from "@domain/agent/tools/proposal-refusals.js";
import { modelsForMode, waysIn, type ModelInfo, type WayIn, type WayKind } from "@domain/model-catalog/mode-catalog.js";

/**
 * What a node holds, which decides how it may go into a generation. A
 * template's resource lands holding a file we host, fetched once it is placed:
 * nothing needs saying about it, yet it has no address to fill a slot with.
 */
export type Holding = "material" | "resource" | "empty" | "words";

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
  if (node.resource !== undefined) return "resource";
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
    if (way.mark === "ref") return wired ? [poolEntry(way, holding)] : [];
    // The lyrics box is @'d at landing.
    if (way.mark === "placed") return wired && holding !== "material" ? [{ way, by: "edge", ref: false, note: false }] : [];
    // A slot: material fills it as a pick would; anything else is picked by
    // the reader, whom a note tells which node goes there.
    if (holding === "material") return [{ way, by: "fills", ref: false, note: false }];
    return [{ way, by: wired ? "edge" : "unwired", ref: false, note: true }];
  });
}

/**
 * The entry by which a node goes into a pool: an edge and a ref, and a note
 * saying what to put in it or run first when it lands empty.
 * @param way - The pool.
 * @param holding - What the node holds.
 * @returns The entry.
 * @throws {never} Never.
 */
function poolEntry(way: WayIn, holding: Holding): Entry {
  return { way, by: "edge", ref: true, note: holding === "empty" };
}

/**
 * How a node goes into a generation's pool, said where the generation's model
 * is not settled yet: once holding material or words, once empty.
 * @param generation - The generation's name.
 * @returns The sentence.
 * @throws {never} Never.
 */
export function poolSentence(generation: string): string {
  const pool: WayIn = { into: "pool", room: Number.POSITIVE_INFINITY, mark: "ref" };
  return `A node holding material or words goes into "${generation}" ${entryPhrase(poolEntry(pool, "material"), generation)}; an empty one ${entryPhrase(poolEntry(pool, "empty"), generation)}.`;
}

/**
 * One entry, as the agent is told to send it.
 * @param entry - The entry.
 * @param generation - The generation's name, where the fills go on a named one.
 * @returns The phrase.
 * @throws {never} Never.
 */
export function entryPhrase(entry: Entry, generation?: string): string {
  const { into } = entry.way;
  const on = generation === undefined ? "" : ` on "${generation}"`;
  if (entry.by === "fills") return `through fills "${into}"${on}, with no edge and no ref`;
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
 * @param entries - Its entries, from `entriesFor`, at least one.
 * @returns The sentence.
 * @throws {never} Never.
 */
export function waysSentence(subject: string, generation: ProposalNode, entries: readonly Entry[]): string {
  return `${subject} goes into "${generation.name}" ${entries.map((entry) => entryPhrase(entry, generation.name)).join(", or ")}.`;
}

/**
 * How one node goes into a generation by the catalog, said for the agent: each
 * way its model takes a node of its kind holding what it holds, or that the
 * model takes none.
 * @param node - The node.
 * @param generation - The generation.
 * @param chosen - The generation's model.
 * @returns The sentence.
 * @throws {never} Never.
 */
export function waysOrNone(node: ProposalNode, generation: ProposalNode, chosen: ModelInfo): string {
  const entries = entriesFor(chosen, node.type, holdingOf(node));
  return entries.length > 0
    ? waysSentence(`"${node.name}"`, generation, entries)
    : `"${chosen.name}" takes no ${node.type} node, so "${node.name}" has no way into "${generation.name}".`;
}

/**
 * How a node goes into each generation of the group the catalog serves, said
 * for the agent from the catalog alone.
 * @param proposal - The whole proposal.
 * @param node - The node.
 * @param away - A generation to leave out, or none.
 * @returns The sentences, or the empty string where the group has no other generation.
 * @throws {never} Never.
 */
export function waysAcrossGroup(proposal: CanvasProposal, node: ProposalNode, away?: ProposalNode): string {
  return proposal.nodes
    .flatMap((generation) => {
      const chosen = chosenModelOf(generation);
      return generation === away || generation === node || chosen === undefined ? [] : [waysOrNone(node, generation, chosen)];
    })
    .join(" ");
}

/**
 * The slots a model fills straight from material nodes: every way in that the
 * reader would pick a node into, which is every way carrying a note.
 * @param chosen - The model.
 * @returns Each slot with the kind it takes.
 * @throws {never} Never.
 */
function slotsOf(chosen: ModelInfo): { kind: WayKind; way: WayIn }[] {
  return [...waysIn(chosen)].flatMap(([kind, list]) => list.filter((way) => way.mark === "note").map((way) => ({ kind, way })));
}

/**
 * The slots of a model, said for the agent.
 * @param chosen - The model.
 * @returns The phrase.
 * @throws {never} Never.
 */
function slotsPhrase(chosen: ModelInfo): string {
  const names = slotsOf(chosen).map(({ way }) => `"${way.into}"`);
  return names.length > 0 ? `its slots: ${names.join(", ")}` : "it has no slot";
}

/**
 * How many times an element a refusal names appears in the proposal, said
 * after it: nothing for once.
 * @param count - How many times it appears.
 * @returns ", N times", or the empty string.
 * @throws {never} Never.
 */
export function timesNamed(count: number): string {
  return count > 1 ? `, ${String(count)} times` : "";
}

/**
 * A sentence with the space that joins it to the one before, or nothing.
 * @param sentence - The sentence, possibly empty.
 * @returns It with a leading space, or the empty string.
 * @throws {never} Never.
 */
export function spaced(sentence: string): string {
  return sentence === "" ? "" : ` ${sentence}`;
}

/**
 * How nodes of one kind reach one way of a model, said for the agent: once
 * for each thing a node of that kind can hold.
 * @param chosen - The model.
 * @param generation - The generation node.
 * @param kind - The kind the way takes.
 * @param into - The way.
 * @returns The sentences.
 * @throws {never} Never.
 */
export function slotSentence(chosen: ModelInfo, generation: ProposalNode, kind: string, into: string): string {
  return holdingsOf(kind)
    .map((holding) => [holdingSubject(kind, holding), entriesFor(chosen, kind, holding).filter((entry) => entry.way.into === into)] as const)
    .filter(([, entries]) => entries.length > 0)
    .map(([subject, entries]) => waysSentence(subject, generation, entries))
    .join(" ");
}

/**
 * What a node of one kind can hold, each read apart: words for a text node,
 * otherwise standing empty or holding material.
 * @param kind - The kind.
 * @returns Its holdings, in the order they are said.
 * @throws {never} Never.
 */
export function holdingsOf(kind: string): readonly Holding[] {
  return kind === "text" ? ["words"] : ["empty", "material"];
}

/**
 * Any node of one kind holding one thing, as a sentence's subject.
 * @param kind - The kind.
 * @param holding - What it holds.
 * @returns "An image node holding material", "An empty image node", "A written text node".
 * @throws {never} Never.
 */
export function holdingSubject(kind: string, holding: Holding): string {
  if (holding === "words") return "A written text node";
  if (holding === "resource") return `${capitalised(aNode(kind))} holding a template's file`;
  return holding === "material" ? `${capitalised(aNode(kind))} holding material` : `An empty ${kind} node`;
}

/**
 * A phrase with its first letter in capitals.
 * @param phrase - The phrase.
 * @returns It, capitalised.
 * @throws {never} Never.
 */
export function capitalised(phrase: string): string {
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
  return `"${key}" is written in a box of its own on the panel, and nothing set here reaches it. ${slotSentence(chosen, generation, "text", key)}`;
}

/** A node going into a generation, and the entry it arrives by. */
export interface Arriving {
  node: ProposalNode;
  entry: Entry;
}

/** What one edge does for the generation it runs into. */
type EdgeRoute =
  | { kind: "entry"; entry: Entry }
  | { kind: "link" }
  | { kind: "nowhere" }
  | { kind: "ambiguous" }
  | { kind: "no-entry"; into: string };

/**
 * What an edge from a node does for a generation, judged without words: the
 * check refuses from this.
 * @param chosen - The generation's model.
 * @param from - The node at the edge's other end.
 * @param into - What the edge says.
 * @returns The entry it arrives by, or why it arrives by none.
 * @throws {never} Never.
 */
function edgeRoute(chosen: ModelInfo, from: ProposalNode, into: string | undefined): EdgeRoute {
  // A slot of a kind the canvas will not wire in is filled by picking, and
  // the edge itself is refused with the rest of the wiring.
  const options = canConnect(from.type, chosen.nodeType) ? (waysIn(chosen).get(from.type) ?? []) : [];
  // An edge the model takes nothing from still carries the creative link
  // (user 2026-08-13); saying where it goes is a claim the model refutes.
  const [first] = options;
  if (first === undefined) return into === undefined ? { kind: "link" } : { kind: "nowhere" };
  if (into === undefined && options.length > 1) return { kind: "ambiguous" };
  const resolved = into ?? first.into;
  // The edge stands only as one of the node's entries: material reaches a
  // slot through fills, which leaves the snapshot a pick would, so an edge
  // into a slot is no entry of a node holding material.
  const entry = entriesFor(chosen, from.type, holdingOf(from)).find((e) => e.by === "edge" && e.way.into === resolved);
  return entry === undefined ? { kind: "no-entry", into: resolved } : { kind: "entry", entry };
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
  const routed: Arriving[] = [];
  for (const edge of proposal.edges.filter((e) => e.toIndex === index)) {
    const from = proposal.nodes[edge.fromIndex];
    if (!from) continue;
    const route = edgeRoute(chosen, from, edge.into);
    switch (route.kind) {
      case "entry":
        routed.push({ node: from, entry: route.entry });
        break;
      case "link":
        break;
      case "nowhere": {
        const nowhere = `"${chosen.name}" takes no ${from.type} node, so the edge from "${from.name}" goes nowhere in it.`;
        // A source is there to be used, so it is told how the rest of the
        // group takes it; anything else can stay wired as a creative link.
        if (from.role !== "source") return refuse("edge-kind-not-taken-link", `${nowhere} An edge that says no into stands as a creative link.`);
        return refuse("edge-kind-not-taken", `${nowhere}${spaced(waysAcrossGroup(proposal, from, generation))}`);
      }
      case "ambiguous":
        return refuse("edge-into-ambiguous", `The edge from "${from.name}" says no into, and "${chosen.name}" takes ${aNode(from.type)} more than one way. ${waysOrNone(from, generation, chosen)}`);
      case "no-entry":
        return refuse("edge-not-an-entry", `"${from.name}" does not go into "${route.into}" of "${generation.name}" by an edge. ${waysOrNone(from, generation, chosen)}`);
    }
  }
  return { routed };
}

/**
 * The arriving nodes of one kind that go one way.
 * @param arriving - The nodes going into a generation.
 * @param kind - The kind.
 * @param into - The way.
 * @returns The nodes.
 * @throws {never} Never.
 */
export function goingWay(arriving: readonly Arriving[], kind: string, into: string): ProposalNode[] {
  return arriving.filter(({ node, entry }) => node.type === kind && entry.way.into === into).map(({ node }) => node);
}

/**
 * The fix for an index a fill names that cannot stand: every copy of it out,
 * or the fill itself off where nothing else is left in it, since a fill names
 * one node at least.
 * @param off - The fix taking the fill off.
 * @param on - The generation the fill is on.
 * @param param - The fill.
 * @param indices - Every index the fill names.
 * @param index - The index that cannot stand.
 * @param name - The node it points at, where there is one.
 * @returns The fix.
 * @throws {never} Never.
 */
function takeOutOfFill(off: NodeFix, on: NodeLabel, param: string, indices: readonly number[], index: number, name?: string): NodeFix {
  return indices.every((i) => i === index)
    ? off
    : fixOn(on, `take every ${String(index)}${name === undefined ? "" : ` ("${name}")`} out of fills "${param}".`);
}

/**
 * The slots one generation fills straight from material nodes (inner#1315),
 * or the refusal for the first fill that cannot stand.
 *
 * A slot filled this way is what a pick in the panel would leave: a snapshot
 * of the node, with no edge. So it is any way in that carries a note -- never
 * the pool, which an edge carries, nor the lyrics box, which holds words.
 * @param proposal - The whole proposal.
 * @param node - The generation.
 * @param chosen - Its model.
 * @param at - The generation, as a fix names it.
 * @returns Each filled node with its slot, or the refusal.
 * @throws {never} Never.
 */
export function fillsOf(
  proposal: CanvasProposal,
  node: ProposalNode,
  chosen: ModelInfo,
  at: NodeLabel,
): { filled: Arriving[] } | Refusal {
  const slots = slotsOf(chosen);
  const filled: Arriving[] = [];
  for (const [param, indices] of Object.entries(node.fills ?? {})) {
    const off = fixOn(at, `take fills "${param}" off.`);
    // How many times each index is named, counted once for every refusal below.
    const named = new Map<number, number>();
    for (const i of indices) named.set(i, (named.get(i) ?? 0) + 1);
    const outside = indices.find((i) => proposal.nodes[i] === undefined);
    if (outside !== undefined) {
      return refuse("fill-outside", `fills "${param}" on "${node.name}" points at node ${String(outside)}${timesNamed(named.get(outside) ?? 0)}, which is not in the group.`, takeOutOfFill(off, at, param, indices, outside));
    }
    const self = indices.find((i) => proposal.nodes[i] === node);
    if (self !== undefined) {
      return refuse("fill-self", `fills "${param}" on "${node.name}" points at "${node.name}" itself${timesNamed(named.get(self) ?? 0)}, and a node cannot fill its own slot.`, takeOutOfFill(off, at, param, indices, self, node.name));
    }
    const slot = slots.find(({ way }) => way.into === param);
    if (slot === undefined) {
      return chosen.params[param]?.fromReferencePool === true
        ? refuse("fill-into-pool", `"${param}" is the reference pool of "${chosen.name}", which takes no fills; ${slotsPhrase(chosen)}.`, off)
        : refuse("fill-not-a-slot", `"${chosen.name}" has no slot "${param}"; ${slotsPhrase(chosen)}.`, off);
    }
    const seen = new Map<string, ProposalNode>();
    for (const index of indices) {
      const from = proposal.nodes[index] as ProposalNode;
      const count = named.get(index) ?? 0;
      if (from.material === undefined) {
        return refuse("fill-no-material", `fills "${param}" on "${node.name}" points at "${from.name}"${timesNamed(count)}, which holds no material, and fills takes only nodes holding it. ${waysOrNone(from, node, chosen)}`, takeOutOfFill(off, at, param, indices, index, from.name));
      }
      if (from.type !== slot.kind) {
        return refuse("fill-wrong-kind", `"${chosen.name}" takes ${slot.kind} in "${param}", and "${from.name}" is ${from.type}${count > 1 ? ` and is named ${String(count)} times` : ""}. ${waysOrNone(from, node, chosen)}`, takeOutOfFill(off, at, param, indices, index, from.name));
      }
      const twin = seen.get(from.material);
      if (twin === from) {
        return refuse("fill-repeated", `fills "${param}" on "${node.name}" names "${from.name}" ${String(count)} times, and the slot keeps one copy of it.`, fixOn(at, `name it once in fills "${param}".`));
      }
      if (twin !== undefined) {
        return refuse("fill-twice", `fills "${param}" on "${node.name}" holds "${twin.name}" and "${from.name}", which hold the same material, and the slot keeps one copy of it.`);
      }
      seen.set(from.material, from);
      filled.push({ node: from, entry: { way: slot.way, by: "fills", ref: false, note: false } });
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
