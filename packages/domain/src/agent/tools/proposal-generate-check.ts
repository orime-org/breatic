// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The check one generation node answers: its mode and model are in the
 * catalog, its values are ones the panel offers, every node reaching it goes
 * a way the model has with the ref or note that way asks for, and the boxes it
 * fills pass the gate Generate holds them to.
 */
import {
  evaluateExecute,
  extractPromptText,
  PANEL_EDITOR_PARAM,
  promptPlainText,
  promptTextOf,
  proposalMarkSegments,
  referencePool,
  storyboardSend,
  type CanvasProposal,
  type ExecuteVerdict,
  type ProposalNode,
} from "@breatic/shared";

import type { ProposalVerdict } from "@domain/agent/tools/proposal-input.js";
import { fixOn, nodeLabel, refAsSent, refuse, type NodeLabel, type Refusal } from "@domain/agent/tools/proposal-refusals.js";
import { checkParams } from "@domain/agent/tools/proposal-params-check.js";
import {
  aNode,
  entriesFor,
  entryPhrase,
  fillsOf,
  goingWay,
  holdingOf,
  holdingSubject,
  notesAsked,
  notesIn,
  refsIn,
  routeEdges,
  slotSentence,
  timesNamed,
  waysOrNone,
  waysSentence,
  type Arriving,
} from "@domain/agent/tools/proposal-routing.js";
import { modelsForMode, waysIn, type ModelInfo } from "@domain/model-catalog/mode-catalog.js";
import { getModelCatalog } from "@domain/model-catalog/model-catalog.js";

/**
 * The model a generation node names, or why the catalog cannot place it.
 * @param node - The node.
 * @param index - Where it sits, for naming it in a refusal.
 * @returns The model, or the refusal.
 * @throws {never} Never.
 */
function resolveModel(node: ProposalNode, index: number): { chosen: ModelInfo } | Refusal {
  const { mode, model } = node;
  if (node.type === "text") {
    return refuse("text-generates", `"${node.name}" is a text node, and nothing is generated into one; words go on a written node.`);
  }
  if (!mode || !model) return refuse("no-mode-model", `Node ${index} generates, so it needs a mode and a model.`);
  // A mode this node never had and a mode no model here backs are the same
  // answer from the reader's side -- it cannot be proposed -- and
  // `modelsForMode` already names what the node does offer instead.
  const reachable = modelsForMode(node.type, mode);
  if (!reachable.available) {
    return reachable.offered.length > 0
      ? refuse("mode-unbacked", `No model here backs "${mode}" on ${aNode(node.type)}. It offers: ${reachable.offered.join(", ")}.`)
      : refuse("no-model-for-kind", `No ${node.type} model can generate right now.`);
  }
  const chosen = reachable.models.find((m) => m.name === model);
  return chosen
    ? { chosen }
    : refuse("model-not-in-mode", `"${model}" does not back "${mode}". Those that do: ${reachable.models.map((m) => m.name).join(", ")}.`);
}

/**
 * Whether the node's values, shots and prompt suit its model.
 * @param node - The node.
 * @param chosen - Its model.
 * @param at - The node, as a fix names it.
 * @returns Whether it stands, and what is wrong when it does not.
 * @throws {never} Never.
 */
function checkSettings(node: ProposalNode, chosen: ModelInfo, at: NodeLabel): ProposalVerdict {
  const values = checkParams(chosen, node, at);
  if (!values.ok) return values;
  // Defined in the multi-shot mode alone, for a model that takes shots there.
  const board = chosen.storyboard;
  if (node.shots !== undefined && board === undefined) {
    return refuse("shots-outside-multishot", `Shots belong to the multi_shot mode, and "${node.name}" runs "${node.mode ?? ""}".`, fixOn(at, "leave shots out."));
  }
  if (board !== undefined && node.shots === undefined) {
    return refuse("multishot-no-shots", "In the multi_shot mode the shots are what is generated.", fixOn(at, "give shots, each with its own prompt and seconds."));
  }
  // The multi-shot run sends the shots in place of the main prompt, so marks
  // in a main prompt beside them would be counted and priced but never sent.
  if (node.shots !== undefined && (node.prompt?.length ?? 0) > 0) {
    return refuse("shots-with-prompt", "With shots the main prompt is not sent; its words, refs and notes go in the shots.", fixOn(at, "leave prompt out."));
  }
  // A model drawing no box mounts no editor and forces the box empty: only a
  // note, which the reader reads on the card and which is never sent, has a
  // place there. Words, a tweak and an @ all need a box.
  if (!chosen.takesPrompt && proposalMarkSegments(node).some((segment) => segment.slot?.kind !== "note")) {
    return refuse("no-prompt-box", `"${chosen.name}" draws no prompt box, so words, tweak marks and refs written there reach nobody.`, fixOn(at, "keep only notes saying what the reader picks in the panel."));
  }
  return { ok: true };
}

/**
 * The refusal for a ref to a node that is not in the generation's pool.
 * @param proposal - The whole proposal.
 * @param node - The generation.
 * @param chosen - Its model.
 * @param arriving - The nodes going into it, each with its entry.
 * @param stray - The index the ref names.
 * @param at - The generation, as a fix names it.
 * @returns The refusal.
 * @throws {never} Never.
 */
function strayRefReason(
  proposal: CanvasProposal,
  node: ProposalNode,
  chosen: ModelInfo,
  arriving: readonly Arriving[],
  stray: number,
  at: NodeLabel,
): Refusal {
  const named = proposal.nodes[stray];
  // The stray index may be @'d more than once, and every copy has to go.
  const count = refsIn(node).filter((i) => i === stray).length;
  const takeOut = fixOn(at, `take every ${refAsSent(stray)} out.`);
  if (!named) return refuse("ref-outside", `A ref in "${node.name}" points outside the group: ${refAsSent(stray)}${timesNamed(count)}.`, takeOut);
  if (named === node) return refuse("ref-self", `"${node.name}" @s itself with ${refAsSent(stray)}${timesNamed(count)}, and a node cannot @ itself.`, takeOut);
  // Arriving another way -- an edge into a slot or the lyrics box, or a slot
  // filled through fills -- the node is already where it goes; a ref would
  // only send it a second time.
  const elsewhere = arriving.find(({ node: n }) => n === named);
  if (elsewhere) {
    return refuse("ref-arrives-otherwise", `"${named.name}" goes into "${node.name}" ${entryPhrase(elsewhere.entry, node.name)}, and only a node wired into the pool takes a ref.`);
  }
  const ways = waysOrNone(named, node, chosen);
  const byRefs = count > 1 ? `${String(count)} refs` : "a ref";
  const pool = (waysIn(chosen).get(named.type) ?? []).find((way) => way.mark === "ref");
  if (pool === undefined || !entriesFor(chosen, named.type, holdingOf(named)).some((entry) => entry.ref)) {
    return refuse("ref-not-pooled-no-pool", `"${named.name}" is @'d by ${byRefs} in "${node.name}", and only a node in its pool takes a ref, while "${chosen.name}" has no pool for ${aNode(named.type)}. ${ways}`, takeOut);
  }
  const held = goingWay(arriving, named.type, pool.into);
  return refuse("ref-not-pooled", `"${named.name}" is @'d by ${byRefs} in "${node.name}" but is not wired into its pool, and only a node in its pool takes a ref. ${ways} The pool of "${node.name}" takes ${roomOf(pool.room)} ${named.type} node(s) and holds ${namesOrNone(held)}.`);
}

/**
 * How many nodes a way takes, said for the agent.
 * @param room - The way's room.
 * @returns The number, or "any number" for a way with no cap.
 * @throws {never} Never.
 */
function roomOf(room: number): string {
  return Number.isFinite(room) ? String(room) : "any number of";
}

/**
 * Nodes, named for the agent.
 * @param nodes - The nodes.
 * @returns Their names, or "none".
 * @throws {never} Never.
 */
function namesOrNone(nodes: readonly ProposalNode[]): string {
  return nodes.length === 0 ? "none" : nodes.map((n) => `"${n.name}"`).join(", ");
}

/** What a generation's wiring settles: the nodes it takes by edge, and which of them sit in its pool. */
interface Wiring {
  arriving: Arriving[];
  pooled: number[];
}

/**
 * Whether every node reaching a generation goes a way its model has, within
 * that way's room, with the ref or note the way asks for.
 * @param proposal - The whole proposal.
 * @param node - The generation.
 * @param index - Its index.
 * @param chosen - Its model.
 * @param at - The generation, as a fix names it.
 * @returns What the wiring settles, or the refusal.
 * @throws {never} Never.
 */
function checkWiring(proposal: CanvasProposal, node: ProposalNode, index: number, chosen: ModelInfo, at: NodeLabel): Wiring | Refusal {
  const routing = routeEdges(proposal, index, chosen);
  if ("refusal" in routing) return routing;
  const filling = fillsOf(proposal, node, chosen, at);
  if ("refusal" in filling) return filling;
  const arriving = [...routing.routed, ...filling.filled];
  // Over a way's room is said first: every count below would otherwise ask
  // for a mark or note for a node that may not stay.
  for (const [kind, list] of waysIn(chosen)) {
    for (const option of list) {
      const going = goingWay(arriving, kind, option.into);
      if (going.length <= option.room) continue;
      const over = `"${chosen.name}" takes ${String(option.room)} ${kind} node(s) by "${option.into}", and ${String(going.length)} are going that way (${namesOrNone(going)}).`;
      // The rule for each kind of node going this way, and the room and
      // holders of every other way the kind has.
      const holdings = [...new Set(going.map(holdingOf))];
      const rules = holdings.map((holding) => waysSentence(holdingSubject(kind, holding), node, entriesFor(chosen, kind, holding)));
      const others = list.filter((way) => way !== option).map((way) => `"${way.into}" takes ${roomOf(way.room)} ${kind} node(s) and holds ${namesOrNone(goingWay(arriving, kind, way.into))}.`);
      return refuse("way-over-room", [over, ...rules, ...others].join(" "));
    }
  }
  // Every node arriving by an entry with a ref is @'d, and a ref @s only such
  // a node: the mention lands as one the reader would insert from the pool.
  const pooled = arriving.filter(({ entry }) => entry.ref).map(({ node: n }) => proposal.nodes.indexOf(n));
  const refs = refsIn(node);
  const stray = refs.find((i) => !pooled.includes(i));
  if (stray !== undefined) return strayRefReason(proposal, node, chosen, arriving, stray, at);
  // Marks go where the words are sent: with shots, in the shot.
  const where = node.shots === undefined ? "in the prompt" : "in the shot";
  // Every one at once, so a single retry puts them all in.
  const unmentioned = pooled.filter((i) => !refs.includes(i));
  if (unmentioned.length > 0) {
    const names = namesOrNone(unmentioned.flatMap((i) => proposal.nodes[i] ?? []));
    const each = unmentioned.map(refAsSent).join(", ");
    return refuse("ref-missing", `${names} ${unmentioned.length === 1 ? "is" : "are"} wired into the pool of "${node.name}" and no ref @s ${unmentioned.length === 1 ? "it" : "them"}. A node in the pool is used only where a ref @s it ${where}: ${each}.`);
  }
  const asked = notesAsked(arriving);
  const notes = notesIn(node);
  if (notes < asked.length) {
    return refuse("notes-missing", `"${node.name}" needs a note for each of ${asked.map(({ node: n, why }) => `"${n.name}" (${why})`).join(", ")}, and carries ${String(notes)}.`, fixOn(at, `give each one a note ${where}: which slot to pick it into, or what to do first with a node that lands empty.`));
  }
  return { arriving, pooled };
}

/**
 * What the panel sends in place of each ref, the way it serialises it: a text
 * node's words, and a picture, clip or track as its pool's mention, numbered
 * within its kind in the order the pool lists them.
 * @param proposal - The whole proposal.
 * @param node - The generation.
 * @param pooled - The indices wired into its pool, in order.
 * @returns The words for one ref.
 * @throws {never} Never.
 */
function refWordsFor(proposal: CanvasProposal, node: ProposalNode, pooled: readonly number[]): (at: number) => string {
  const pool = node.type === "text"
    ? {}
    : referencePool(getModelCatalog()[node.type]?.find((m) => m.name === node.model), node.mode ?? "");
  return (at) => {
    const target = proposal.nodes[at];
    if (!target) return "";
    if (target.type === "text") return promptPlainText(target.prompt ?? []);
    const mention = pool[target.type]?.mention;
    if (mention === undefined) return "";
    const n = pooled.filter((i) => proposal.nodes[i]?.type === target.type).indexOf(at);
    return mention.replace("{n}", String(n + 1)).replace("{i}", String(n));
  };
}

/**
 * The refusal the panel's gate gives, said for the agent.
 * @param verdict - The gate's verdict.
 * @param node - The generation.
 * @param chosen - Its model.
 * @param sent - The prompt as it goes out.
 * @param scripts - The text nodes @'d into it.
 * @param at - The generation, as a fix names it.
 * @returns The reason, or null where the gate lets it through.
 * @throws {never} Never.
 */
function gateReason(verdict: ExecuteVerdict, node: ProposalNode, chosen: ModelInfo, sent: string, scripts: readonly ProposalNode[], at: NodeLabel): Refusal | null {
  const model = chosen.name;
  const board = chosen.storyboard;
  switch (verdict.refusal) {
    case "storyboard-shot-empty":
      return refuse("shot-empty", `Shot ${String(verdict.shot)} writes nothing. Every shot needs its own words.`);
    case "storyboard-too-many":
      return refuse("too-many-shots", `"${model}" takes at most ${String(verdict.limit)} shots, and this proposal gives ${String(verdict.found)}.`);
    case "storyboard-shot-too-long":
      return refuse("shot-too-long", `Shot ${String(verdict.shot)} is ${String(verdict.found)} characters, longer than the ${String(verdict.limit)} characters "${model}" takes for one shot.`);
    case "storyboard-duration-mismatch":
      return refuse("shots-duration", `The shots add up to ${String(verdict.seconds?.shots)} seconds and ${String(board?.totalParam)} is ${String(verdict.seconds?.total)}.`);
    case "prompt-missing":
    case "style-missing":
      return refuse("prompt-missing", `"${model}" generates from what the prompt says, and this proposal writes nothing in it.`, fixOn(at, "write a prompt."));
    case "lyrics-missing":
      return refuse("lyrics-missing", `"${model}" sings the words in its lyrics box, and this proposal leaves it empty. ${slotSentence(chosen, node, "text", PANEL_EDITOR_PARAM)}`);
    case "prompt-too-long": {
      const written = [...extractPromptText(sent)].length;
      const holding = scripts.map((n) => `"${n.name}"`);
      return refuse("prompt-too-long", `"${model}" takes ${String(chosen.maxInputChars)} characters and this prompt is ${String(written)}${board === undefined ? "" : " with the shots written into it"}${holding.length > 0 ? `, counting the words in ${holding.join(", ")}` : ""}.`);
    }
    default:
      return null;
  }
}

/**
 * Whether the boxes a generation fills pass the gate Generate holds them to,
 * asked with the text they will hold. A note is left out of it.
 * @param proposal - The whole proposal.
 * @param node - The generation.
 * @param chosen - Its model.
 * @param wiring - What its wiring settled.
 * @param at - The generation, as a fix names it.
 * @returns Whether it stands, and the gate's refusal when it does not.
 * @throws {never} Never.
 */
function checkPanelGate(proposal: CanvasProposal, node: ProposalNode, chosen: ModelInfo, wiring: Wiring, at: NodeLabel): ProposalVerdict {
  const { arriving, pooled } = wiring;
  const board = chosen.storyboard;
  const scripts = pooled.flatMap((at) => {
    const target = proposal.nodes[at];
    return target?.type === "text" ? [target] : [];
  });
  const shotCap = board?.maxChars;
  const long = shotCap === undefined ? undefined : scripts.find((n) => [...extractPromptText(promptPlainText(n.prompt ?? []))].length > shotCap);
  if (long) {
    return refuse("script-too-long-for-shot", `"${long.name}" is longer than the ${String(shotCap)} characters "${chosen.name}" takes for one shot, so @'ing it into a shot is refused at Generate.`);
  }
  const refWords = refWordsFor(proposal, node, pooled);
  const shots = (node.shots ?? []).map((shot) => ({ text: promptTextOf(shot.prompt, refWords), duration: shot.duration }));
  const totalParam = board?.totalParam;
  const total = totalParam === undefined ? undefined : Number(node.params?.[totalParam] ?? chosen.params[totalParam]?.default);
  // What goes out as the prompt: the shots written into one, for a model with
  // no field for them, so its length is held to the model's cap.
  const sent = board === undefined
    ? promptTextOf(node.prompt ?? [], refWords)
    : (storyboardSend(board, shots.map((shot) => ({ prompt: shot.text, duration: shot.duration }))).prompt ?? "");
  // A song model's lyrics box is a second box the panel holds to the same
  // gate: the words of the nodes wired into it, a line apart.
  const lyricsRequired = waysIn(chosen).get("text")?.some((way) => way.into === PANEL_EDITOR_PARAM) === true;
  const lyricsText = arriving
    .filter(({ entry }) => entry.way.into === PANEL_EDITOR_PARAM)
    .map(({ node: n }) => promptPlainText(n.prompt ?? []))
    .join("\n");
  const verdict = evaluateExecute({
    promptText: sent,
    model: chosen.name,
    nodeExists: true,
    isSubmitting: false,
    promptRequired: chosen.takesPrompt,
    ...(lyricsRequired ? { lyricsRequired, lyricsText } : {}),
    ...(chosen.maxInputChars === undefined ? {} : { maxInputChars: chosen.maxInputChars }),
    ...(node.shots !== undefined && total !== undefined
      ? { storyboard: { shots, total, ...(board === undefined ? {} : { maxShots: board.maxShots }), ...(shotCap === undefined ? {} : { maxChars: shotCap }) } }
      : {}),
  });
  return (verdict === null ? null : gateReason(verdict, node, chosen, sent, scripts, at)) ?? { ok: true };
}

/**
 * Judge one generation node against the catalog and its own group.
 * @param proposal - The whole proposal, for reading the group around it.
 * @param node - The node being judged.
 * @param index - Where it sits, for naming it in a refusal.
 * @returns Whether it stands, and what is missing when it does not.
 * @throws {never} Never.
 */
export function checkGenerateNode(proposal: CanvasProposal, node: ProposalNode, index: number): ProposalVerdict {
  const resolved = resolveModel(node, index);
  if ("refusal" in resolved) return resolved;
  const { chosen } = resolved;
  const at = nodeLabel(proposal.nodes, index);
  const settings = checkSettings(node, chosen, at);
  if (!settings.ok) return settings;
  const wiring = checkWiring(proposal, node, index, chosen, at);
  if ("refusal" in wiring) return wiring;
  return checkPanelGate(proposal, node, chosen, wiring, at);
}
