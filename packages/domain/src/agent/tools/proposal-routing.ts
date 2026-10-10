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
 * How a node goes into a generation's pool, for advice given before the
 * generation's model is settled: once holding material or words, once empty.
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
 * @param generation - The generation's name.
 * @returns The phrase.
 * @throws {never} Never.
 */
export function entryPhrase(entry: Entry, generation: string): string {
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
 * @param entries - Its entries, from `entriesFor`, at least one.
 * @returns The sentence.
 * @throws {never} Never.
 */
export function waysSentence(subject: string, generation: ProposalNode, entries: readonly Entry[]): string {
  return `${subject} goes into "${generation.name}" ${entries.map((entry) => entryPhrase(entry, generation.name)).join(", or ")}.`;
}

/**
 * How one named node goes into a generation as the proposal stands, said for
 * the agent. Where the model takes nothing of its kind, or every way it has is
 * closed to this node, the sentence says why each way is closed and where else
 * in the group the node goes, so it is never left with nowhere to be.
 * @param proposal - The whole proposal.
 * @param node - The node.
 * @param generation - The generation.
 * @param chosen - The generation's model.
 * @param byEdge - Whether an edge now runs from the node into the generation, which then has to come off.
 * @param before - Nodes the same advice has already sent in.
 * @returns The sentence.
 * @throws {never} Never.
 */
export function nodeWaysSentence(
  proposal: CanvasProposal,
  node: ProposalNode,
  generation: ProposalNode,
  chosen: ModelInfo,
  byEdge = false,
  before: readonly Arriving[] = [],
): string {
  const { open, closed } = wayStates(proposal, node, generation, chosen, before);
  if (open.length > 0) return waysSentence(`"${node.name}"`, generation, open);
  const takeOff = byEdge ? "Take that edge off. " : "";
  const why = closed.length === 0
    ? `"${chosen.name}" takes no ${node.type} node, so "${node.name}" has no way into "${generation.name}".`
    : `"${node.name}" has no way left into "${generation.name}": ${closed.map((state) => closedPhrase(state.entry, state.closed)).join("; ")}.`;
  return `${takeOff}${why}${spaced(elsewhereSentence(proposal, node, generation))}`;
}

/**
 * How each of several nodes one piece of advice sends goes into a
 * generation, said for the agent: each with its way, or why it has none and
 * where it goes instead.
 * @param proposal - The whole proposal.
 * @param nodes - The nodes.
 * @param generation - The generation.
 * @param chosen - Its model.
 * @returns The sentences.
 * @throws {never} Never.
 */
export function placedWaysSentence(proposal: CanvasProposal, nodes: readonly ProposalNode[], generation: ProposalNode, chosen: ModelInfo): string {
  // A node that already goes in stays in once the advice is followed, so it
  // is told nothing.
  const arrived = new Set(arrivingInto(proposal, generation, chosen).map(({ node }) => node));
  return placeEach(proposal, nodes.filter((node) => !arrived.has(node)), generation, chosen)
    .map(({ node, ways, before }) => (ways.length > 0 ? waysSentence(`"${node.name}"`, generation, ways) : nodeWaysSentence(proposal, node, generation, chosen, false, before)))
    .join(" ");
}

/**
 * Why one way is closed to a node, said for the agent.
 * @param entry - The way.
 * @param closed - Why it is closed.
 * @returns The phrase.
 * @throws {never} Never.
 */
function closedPhrase(entry: Entry, closed: Closed): string {
  return closed.why === "twin"
    ? `"${closed.twin.name}" already brings the same material into "${entry.way.into}"`
    : `"${entry.way.into}" has no room left`;
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
 * Where a source node goes once it does not go into one generation: nothing
 * when it already goes into another; else each other generation here with a
 * way left for it, how; else that it comes out. A node that generates or holds
 * words stands on the canvas without going anywhere, so it needs nothing said.
 * @param proposal - The whole proposal.
 * @param from - The node.
 * @param away - The generation it does not go into, or none.
 * @returns The sentence, or the empty string.
 * @throws {never} Never.
 */
export function elsewhereSentence(proposal: CanvasProposal, from: ProposalNode, away?: ProposalNode): string {
  if (from.role !== "source") return "";
  const others = proposal.nodes.flatMap((generation) => {
    const chosen = chosenModelOf(generation);
    return generation === away || chosen === undefined ? [] : [[generation, chosen] as const];
  });
  if (others.some(([generation, chosen]) => arrivingInto(proposal, generation, chosen).some(({ node }) => node === from))) return "";
  const takers = others.flatMap(([generation, chosen]) => {
    const open = openEntries(proposal, from, generation, chosen);
    return open.length > 0 ? [waysSentence(`"${from.name}"`, generation, open)] : [];
  });
  if (takers.length > 0) return `Send it into a generation that takes it: ${takers.join(" ")}`;
  return `No other generation here has a way left for "${from.name}"; take "${from.name}" out, or propose a model that takes it.`;
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
    .map(([subject, entries]) => waysSentence(subject, generation, entries))
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
 * check refuses from this, and the advice counts what already arrives by it.
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
        // A source is there to be used, so it is told where it goes instead;
        // anything else can stay wired as a creative link.
        if (from.role !== "source") return refuse("edge-kind-not-taken-link", `${nowhere} Leave into off that edge, or propose a model that takes it.`);
        return refuse("edge-kind-not-taken", `${nowhere} Take that edge off.${spaced(elsewhereSentence(proposal, from, generation))}`);
      }
      case "ambiguous":
        return refuse("edge-into-ambiguous", `The edge from "${from.name}" says no into, and "${chosen.name}" takes ${aNode(from.type)} more than one way. ${nodeWaysSentence(proposal, from, generation, chosen, true)}`);
      case "no-entry":
        return refuse("edge-not-an-entry", `"${from.name}" does not go into "${route.into}" of "${generation.name}" by an edge. ${nodeWaysSentence(proposal, from, generation, chosen, true)}`);
    }
  }
  return { routed };
}

/** Why the check refuses one fill, as data the refusal is said from. */
type FillProblem =
  | { kind: "outside"; param: string; at: number }
  | { kind: "self"; param: string }
  | { kind: "not-a-slot"; param: string; named: ProposalNode[] }
  | { kind: "no-material"; param: string; from: ProposalNode }
  | { kind: "wrong-kind"; param: string; from: ProposalNode; slotKind: string }
  | { kind: "repeated"; param: string; from: ProposalNode }
  | { kind: "twin"; param: string; from: ProposalNode; twin: ProposalNode };

/**
 * Every fill one generation names, judged once: the nodes that stand in their
 * slot, and why each other one is refused, in the order the check meets them.
 * The check refuses from the first problem; the advice counts only what stands.
 * @param proposal - The whole proposal.
 * @param generation - The generation.
 * @param chosen - Its model.
 * @returns The fills that stand and the problems.
 * @throws {never} Never.
 */
function judgeFills(proposal: CanvasProposal, generation: ProposalNode, chosen: ModelInfo): { filled: Arriving[]; problems: FillProblem[] } {
  const slots = [...waysIn(chosen)].flatMap(([kind, list]) => list.filter((way) => way.mark === "note").map((way) => ({ kind, way })));
  const filled: Arriving[] = [];
  const problems: FillProblem[] = [];
  for (const [param, indices] of Object.entries(generation.fills ?? {})) {
    // A bad index is refused on its own; the nodes beside it still count, so
    // advice reads the slot as the nodes it names fill it.
    const outside = indices.find((at) => proposal.nodes[at] === undefined);
    if (outside !== undefined) problems.push({ kind: "outside", param, at: outside });
    const all = indices.flatMap((at) => proposal.nodes[at] ?? []);
    if (all.includes(generation)) problems.push({ kind: "self", param });
    const named = all.filter((from) => from !== generation);
    const slot = slots.find(({ way }) => way.into === param);
    if (slot === undefined) {
      problems.push({ kind: "not-a-slot", param, named });
      continue;
    }
    const { kind: slotKind, way } = slot;
    const seen = new Map<string, ProposalNode>();
    for (const from of named) {
      if (from.material === undefined) {
        problems.push({ kind: "no-material", param, from });
        continue;
      }
      if (from.type !== slotKind) {
        problems.push({ kind: "wrong-kind", param, from, slotKind });
        continue;
      }
      const twin = seen.get(from.material);
      if (twin !== undefined) {
        problems.push(twin === from ? { kind: "repeated", param, from } : { kind: "twin", param, from, twin });
        continue;
      }
      seen.set(from.material, from);
      filled.push({ node: from, entry: { way, by: "fills", ref: false, note: false } });
    }
  }
  return { filled, problems };
}

/**
 * Every node that goes into one generation as the proposal stands, by an edge
 * that routes or a fill that stands, with the entry it arrives by. Edges and
 * fills the check refuses arrive by nothing here.
 * @param proposal - The whole proposal.
 * @param generation - The generation.
 * @param chosen - Its model.
 * @returns The arriving nodes.
 * @throws {never} Never.
 */
function arrivingInto(proposal: CanvasProposal, generation: ProposalNode, chosen: ModelInfo): Arriving[] {
  const index = proposal.nodes.indexOf(generation);
  const byEdge = proposal.edges.flatMap((edge): Arriving[] => {
    const from = proposal.nodes[edge.fromIndex];
    if (edge.toIndex !== index || !from) return [];
    const route = edgeRoute(chosen, from, edge.into);
    return route.kind === "entry" ? [{ node: from, entry: route.entry }] : [];
  });
  return [...byEdge, ...judgeFills(proposal, generation, chosen).filled];
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

/** Why a way is closed to a node: other nodes fill its room, or one already brings the same material. */
type Closed = { why: "room" } | { why: "twin"; twin: ProposalNode };

/**
 * Each way a node can go into a generation, and, for each, whether it is
 * closed to the node as the proposal stands and why: the other arriving nodes
 * fill its room, or a fill already brings the same material into that slot.
 * The advice on how a node goes in reads this, so none can offer a way the
 * check refuses; the note rule for unwired sources in checkUnsentNotes judges
 * slot kinds alone (inner#1389).
 * @param proposal - The whole proposal.
 * @param node - The node.
 * @param generation - The generation.
 * @param chosen - Its model.
 * @param placed - Nodes the same advice has already sent in, each by the way it was given.
 * @returns The open entries, and the closed ones with why.
 * @throws {never} Never.
 */
function wayStates(
  proposal: CanvasProposal,
  node: ProposalNode,
  generation: ProposalNode,
  chosen: ModelInfo,
  placed: readonly Arriving[],
): { open: Entry[]; closed: { entry: Entry; closed: Closed }[] } {
  const others = [...arrivingInto(proposal, generation, chosen).filter((arrival) => arrival.node !== node), ...placed];
  const open: Entry[] = [];
  const closed: { entry: Entry; closed: Closed }[] = [];
  for (const entry of entriesFor(chosen, node.type, holdingOf(node))) {
    const twin = entry.by === "fills" ? others.find((arrival) => arrival.entry.way.into === entry.way.into && arrival.node.material === node.material) : undefined;
    if (goingWay(others, node.type, entry.way.into).length >= entry.way.room) closed.push({ entry, closed: { why: "room" } });
    else if (twin !== undefined) closed.push({ entry, closed: { why: "twin", twin: twin.node } });
    else open.push(entry);
  }
  return { open, closed };
}

/**
 * The entries by which a node can still go into a generation as the proposal stands.
 * @param proposal - The whole proposal.
 * @param node - The node.
 * @param generation - The generation.
 * @param chosen - Its model.
 * @returns The open entries.
 * @throws {never} Never.
 */
export function openEntries(proposal: CanvasProposal, node: ProposalNode, generation: ProposalNode, chosen: ModelInfo): Entry[] {
  return wayStates(proposal, node, generation, chosen, []).open;
}

/** One node of several sent in by the same advice, with the ways it is told. */
export interface Placement {
  /** The node. */
  node: ProposalNode;
  /** The ways it is told: every open one when it is sent alone, else the one it is given; none when none is left. */
  ways: Entry[];
  /** The nodes sent in before it by the same advice. */
  before: readonly Arriving[];
}

/**
 * Where each of several nodes goes into a generation when one piece of advice
 * sends them all. They are placed in turn, each counted where it was sent
 * before the next is judged, so room and same material hold across them; when
 * more than one is sent, each is given one way, since two given the same
 * choice could take the same slot.
 * @param proposal - The whole proposal.
 * @param nodes - The nodes, in the order they are told.
 * @param generation - The generation.
 * @param chosen - Its model.
 * @param allowed - The ways the advice may send them.
 * @returns One placement per node.
 * @throws {never} Never.
 */
export function placeEach(
  proposal: CanvasProposal,
  nodes: readonly ProposalNode[],
  generation: ProposalNode,
  chosen: ModelInfo,
  allowed: (entry: Entry) => boolean = () => true,
): Placement[] {
  const placed: Arriving[] = [];
  return nodes.map((node) => {
    const before = [...placed];
    const open = wayStates(proposal, node, generation, chosen, before).open.filter(allowed);
    const ways = nodes.length === 1 ? open : open.slice(0, 1);
    const [first] = ways;
    if (first !== undefined) placed.push({ node, entry: first });
    return { node, ways, before };
  });
}

/**
 * The slots one generation fills straight from material nodes (inner#1315),
 * or the refusal for the first fill that cannot stand.
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
  const { filled, problems } = judgeFills(proposal, node, chosen);
  const [problem] = problems;
  if (problem === undefined) return { filled };
  const { param } = problem;
  switch (problem.kind) {
    case "outside":
      return refuse("fill-outside", `fills "${param}" on "${node.name}" points at node ${String(problem.at)}, which is not in the group.`);
    case "self":
      return refuse("fill-self", `fills "${param}" on "${node.name}" points at "${node.name}" itself, and a node cannot fill its own slot. Check the index the fill means.`);
    case "not-a-slot": {
      const told = placedWaysSentence(proposal, [...new Set(problem.named)], node, chosen);
      return chosen.params[param]?.fromReferencePool === true
        ? refuse("fill-into-pool", `"${param}" is the reference pool of "${chosen.name}", which takes no fills. Take fills "${param}" off.${spaced(told)}`)
        : refuse("fill-not-a-slot", `"${chosen.name}" has no slot "${param}". Take fills "${param}" off.${spaced(told)}`);
    }
    case "no-material":
      return refuse("fill-no-material", `fills "${param}" on "${node.name}" points at "${problem.from.name}", which holds no material, and fills takes only nodes holding it. Take "${problem.from.name}" out of fills "${param}". ${nodeWaysSentence(proposal, problem.from, node, chosen)}`);
    case "wrong-kind":
      return refuse("fill-wrong-kind", `"${chosen.name}" takes ${problem.slotKind} in "${param}", and "${problem.from.name}" is ${problem.from.type}. Take "${problem.from.name}" out of fills "${param}". ${nodeWaysSentence(proposal, problem.from, node, chosen)}`);
    case "repeated":
      return refuse("fill-repeated", `fills "${param}" on "${node.name}" names "${problem.from.name}" twice, and the slot keeps one copy of it. Name it once.`);
    case "twin":
      return refuse("fill-twice", `fills "${param}" on "${node.name}" holds "${problem.twin.name}" and "${problem.from.name}", which hold the same material, and the slot keeps one copy of it. Take "${problem.from.name}" out.`);
  }
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
