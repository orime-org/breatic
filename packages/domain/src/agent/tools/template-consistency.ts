// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Whether each template the agent anchors in a proposal is there whole
 * (inner#1345 design 6.7 step 3).
 *
 * The agent sends a template's nodes as ordinary nodes, each tagged with its
 * key, and wires them itself. Which nodes belong to one anchor is read by the
 * same match the generate panel uses on the canvas (`matchTemplateInstance`),
 * so a proposal the check takes is one the panel reads back as the same
 * instance. A node the agent moved off the template's mode or model ends the
 * template there: nothing upstream of it is asked for.
 */

import {
  matchTemplateInstance,
  templateSkeleton,
  type CanvasProposal,
  type GenerationTemplate,
  type TemplateGraphNode,
  type TemplateInstanceMatch,
  type TemplateNodeKey,
} from "@breatic/shared";

import type { ProposalVerdict } from "@domain/agent/tools/proposal-input.js";
import { fixOn, nodeLabel, refuse, type NodeFix } from "@domain/agent/tools/proposal-refusals.js";
import { chosenModelOf, entriesFor, entryPhrase, holdingOf } from "@domain/agent/tools/proposal-routing.js";
import { sentWords, type TemplatePlace } from "@domain/agent/tools/template-expansion.js";

/** One anchor of the proposal and what the match found for it. */
export interface AnchoredInstance {
  /** The anchor's index. */
  anchor: number;
  place: Extract<TemplatePlace, { key: TemplateNodeKey }>;
  match: TemplateInstanceMatch;
}

/**
 * Whether a node keeps the mode and model its template gives it.
 * @param proposal - The proposal.
 * @param index - The node's index.
 * @param place - Where it stands in its template.
 * @returns Whether it keeps both; a node the template does not generate keeps them trivially.
 * @throws {never} Never.
 */
function keeps(proposal: CanvasProposal, index: number, place: Extract<TemplatePlace, { key: TemplateNodeKey }>): boolean {
  const own = place.template.nodes.find((one) => one.key === place.key);
  const node = proposal.nodes[index];
  if (own?.role !== "generate" || node === undefined) return true;
  return node.mode === own.mode && node.model === own.model;
}

/**
 * Every anchor of the proposal, each matched against the proposal as a graph:
 * nodes by index, a non-anchor key's node carrying its tag, the anchor none,
 * as on the canvas, and each node's incoming edges in the order sent.
 * @param proposal - The resolved proposal.
 * @param places - Each node's place in a template, where it names one.
 * @returns Each anchor and its match.
 * @throws {never} Never.
 */
export function anchoredInstances(proposal: CanvasProposal, places: readonly (TemplatePlace | undefined)[]): AnchoredInstance[] {
  const nodes = new Map<string, TemplateGraphNode>(
    proposal.nodes.map((node, index): [string, TemplateGraphNode] => {
      const place = places[index];
      const id = String(index);
      if (place === undefined) return [id, { id, type: node.type, keeps: true }];
      // The tag names its anchor by index; the graph names nodes by id, the index as a string.
      const anchor = place.tagAnchor === undefined ? {} : { anchor: String(place.tagAnchor) };
      if ("input" in place) return [id, { id, type: node.type, inputTag: { template: place.template.id, input: place.input, ...anchor }, keeps: true }];
      const tag = place.anchor ? {} : { tag: { template: place.template.id, key: place.key, ...anchor } };
      return [id, { id, type: node.type, ...tag, keeps: keeps(proposal, index, place) }];
    }),
  );
  const incoming = new Map<string, { from: string; into?: string }[]>();
  for (const edge of proposal.edges) {
    const to = String(edge.toIndex);
    incoming.set(to, [...(incoming.get(to) ?? []), edge.into === undefined ? { from: String(edge.fromIndex) } : { from: String(edge.fromIndex), into: edge.into }]);
  }
  // A slot filled through fills has no edge; the match finds an input there by its slot.
  const fills = new Map<string, Map<string, string>>();
  proposal.nodes.forEach((node, index) => {
    const named = Object.entries(node.fills ?? {}).flatMap(([param, from]): [string, string][] => (from[0] === undefined ? [] : [[param, String(from[0])]]));
    if (named.length > 0) fills.set(String(index), new Map(named));
  });
  return places.flatMap((place, anchor): AnchoredInstance[] => {
    if (place === undefined || "input" in place || !place.anchor) return [];
    return [{ anchor, place, match: matchTemplateInstance(templateSkeleton(place.template), { nodes, incoming, fills }, String(anchor)) }];
  });
}

/**
 * Whether every anchored template is there whole: each key it reaches present
 * once and wired where the template wires it, and each input given a node on
 * every generation it feeds.
 * @param proposal - The resolved proposal.
 * @param instances - Each anchor and its match.
 * @returns Whether it stands, and what is missing when it does not.
 * @throws {never} Never.
 */
export function checkTemplateInstances(proposal: CanvasProposal, instances: readonly AnchoredInstance[]): ProposalVerdict {
  for (const { anchor, place, match } of instances) {
    const id = place.template.id;
    const at = nodeLabel(proposal.nodes, anchor);
    /**
     * A matched node as a refusal names it.
     * @param node - The node id, its index as a string.
     * @returns The label.
     */
    const label = (node: string): string => nodeLabel(proposal.nodes, Number(node));
    /**
     * The index of the node a key stands on: the anchor's, or the node matched to it.
     * @param key - The key.
     * @returns The index, or undefined when no node stands there.
     */
    const indexAt = (key: TemplateNodeKey): number | undefined => {
      if (key === place.template.anchor) return anchor;
      const node = nodeIdOf(match, key);
      return node === "" ? undefined : Number(node);
    };
    /**
     * The fix that sends one node into another the way a template edge does,
     * with the ref and note that route asks for (`entriesFor`).
     * @param from - The index of the node sent in.
     * @param to - The index of the node it goes into.
     * @param into - Where on that node it goes.
     * @param edge - Whether the edge from that node is already there, to be changed.
     * @returns The fix.
     */
    const routeFix = (from: number, to: number, into: string, edge: "add" | "change"): NodeFix => {
      const node = proposal.nodes[from];
      const generation = proposal.nodes[to];
      const chosen = generation === undefined ? undefined : chosenModelOf(generation);
      // The registry test passes every template through this check, so its edges go a way their model takes.
      const ways = node === undefined || chosen === undefined ? [] : entriesFor(chosen, node.type, holdingOf(node)).filter((one) => one.way.into === into);
      const subject = nodeLabel(proposal.nodes, from);
      // Material goes into a slot through fills alone (an input into a slot, inner#1825).
      const filled = ways.find((one) => one.by === "fills");
      if (filled !== undefined) {
        const lead = edge === "add" ? `send ${subject} into it` : `take the edge from ${subject} off and send it into it`;
        return fixOn(nodeLabel(proposal.nodes, to), `${lead} ${entryPhrase(filled)}.`);
      }
      const entry = ways.find((one) => one.by === "edge");
      const how = entry === undefined ? `by an edge with into: "${into}"` : entryPhrase(entry);
      const marks = [...(entry?.ref === true ? ["ref"] : []), ...(entry?.note === true ? ["note"] : [])];
      const placed = generation?.role === "generate" ? sentWords(generation.mode).placed : "";
      const shot = marks.length > 0 && placed !== "" ? `, its ${marks.join(" and ")}${placed}` : "";
      const lead = edge === "add" ? `send ${subject} into it` : `change the edge from ${subject} so it goes into it`;
      return fixOn(nodeLabel(proposal.nodes, to), `${lead} ${how}${shot}.`);
    };
    for (const [key, found] of match.keys) {
      const standing = keyStanding(place.template, key);
      if (found.kind === "many") {
        const how = standing === "standalone" ? `each tagged with ${at} as its anchor` : "each wired in where it goes";
        return refuse("template-key-repeated", `Template "${id}" anchored at ${at} takes one "${key}" node, and ${found.nodes.map(label).join(", ")} are ${how}.`);
      }
      if (found.kind !== "missing") continue;
      const candidates = match.candidates.get(key) ?? [];
      const own = place.template.nodes.find((node) => node.key === key);
      const kind = `${own?.role ?? ""} ${own?.type ?? ""}`;
      if (standing === "standalone") {
        const loose = candidates.length === 0 ? "" : ` Nodes tagged "${key}" whose tag names no anchor on the proposal: ${candidates.map(label).join(", ")}.`;
        return refuse(
          "template-key-missing",
          `Template "${id}" anchored at ${at} places a ${kind} "${key}" node beside it with no edge, tied to it by the tag ` +
            `{ id: "${id}", key: "${key}", anchor: ${String(anchor)} }, anchor being the index of ${at}, and no node carries that tag.${loose}`,
        );
      }
      // An upstream key is found along its edge into the node it feeds, a downstream one along its edge from the node feeding it.
      const below = standing === "downstream";
      const edge = match.walked.find((one) => (below ? one.to === key : one.from === key));
      const only = candidates[0];
      const into = edge?.into ?? "pool";
      const near = edge === undefined ? undefined : indexAt(below ? edge.from : edge.to);
      const nearKey = (below ? edge?.from : edge?.to) ?? place.template.anchor;
      const where = near === undefined ? `its "${nearKey}" node` : nodeLabel(proposal.nodes, near);
      if (candidates.length === 1 && only !== undefined && edge !== undefined && near !== undefined) {
        const [from, to] = below ? [near, Number(only)] : [Number(only), near];
        const wired = below ? `its "${nearKey}" node, ${where}, into "${key}"` : `its "${key}" node into "${nearKey}"`;
        return refuse(
          "template-edge-missing",
          `Template "${id}" anchored at ${at} wires ${wired} by "${into}", and ${label(only)}, tagged "${key}", has no edge ${below ? `from ${where}` : "there"}.`,
          routeFix(from, to, into, "add"),
        );
      }
      const listed = candidates.length === 0 ? "" : ` Nodes tagged "${key}" that are wired nowhere it goes: ${candidates.map(label).join(", ")}.`;
      const wires = below ? `its "${nearKey}" node, ${where}, into a ${kind} "${key}" node` : `a ${kind} "${key}" node into ${where}`;
      return refuse(
        "template-key-missing",
        `Template "${id}" anchored at ${at} wires ${wires} by "${into}", and none is wired ${below ? `from ${where}` : "in there"}.${listed}`,
      );
    }
    const unwired = match.unwired[0];
    if (unwired !== undefined) {
      const from = indexAt(unwired.from);
      const to = indexAt(unwired.to);
      if (from !== undefined && to !== undefined) {
        const into = unwired.into ?? "pool";
        return refuse(
          "template-edge-missing",
          `Template "${id}" anchored at ${at} wires its "${unwired.from}" node into "${unwired.to}" by "${into}" as well, and ${nodeLabel(proposal.nodes, from)} has no edge there.`,
          routeFix(from, to, into, "add"),
        );
      }
    }
    for (const edge of match.walked) {
      const from = indexAt(edge.from);
      const to = indexAt(edge.to);
      const sent = proposal.edges.find((one) => one.fromIndex === from && one.toIndex === to);
      const want = edge.into ?? "pool";
      if (sent?.into === undefined || sent.into === want || from === undefined || to === undefined) continue;
      return refuse(
        "template-edge-into",
        `Template "${id}" anchored at ${at} sends its "${edge.from}" node into "${edge.to}" by "${want}", and the edge from ${nodeLabel(proposal.nodes, from)} says into "${sent.into}".`,
        routeFix(from, to, want, "change"),
      );
    }
    for (const input of place.template.inputs) {
      if (input.into === undefined) continue;
      for (const [fed, node] of match.inputs.get(input.key) ?? []) {
        const from = Number(node);
        const to = indexAt(fed);
        const sent = proposal.edges.find((one) => one.fromIndex === from && one.toIndex === to);
        if (sent?.into === undefined || sent.into === input.into || to === undefined) continue;
        return refuse(
          "template-input-into",
          `Template "${id}" anchored at ${at} takes input "${input.key}" into the "${input.into}" slot of ${nodeLabel(proposal.nodes, to)}, not its pool or another slot, and the edge from ${label(node)} says into "${sent.into}".`,
          routeFix(from, to, input.into, "change"),
        );
      }
    }
    const missing = match.unassigned[0];
    if (missing !== undefined) {
      const input = place.template.inputs.find((one) => one.key === missing.input);
      const fed = missing.fed === place.template.anchor ? at : label(nodeIdOf(match, missing.fed));
      const there = input?.into === undefined ? "wired in there" : `wired into its "${input.into}" slot or filling it through fills`;
      return refuse("template-input-missing", `Template "${id}" takes input "${missing.input}" on ${fed}, and no ${input?.type ?? ""} node of its own is ${there}.`);
    }
  }
  return { ok: true };
}

/**
 * The node a key was matched to.
 * @param match - The match.
 * @param key - A key the match found one or more nodes for.
 * @returns The node id.
 * @throws {never} Never.
 */
function nodeIdOf(match: TemplateInstanceMatch, key: TemplateNodeKey): string {
  const found = match.keys.get(key);
  if (found?.kind === "one") return found.node;
  if (found?.kind === "many") return found.nodes[0] ?? "";
  return "";
}

/**
 * Where a non-anchor key stands in its template (inner#1825): upstream,
 * reaching the anchor along template edges; downstream, reached from it; or
 * standalone, touched by no template edge.
 * @param template - The template.
 * @param key - The key.
 * @returns Where it stands.
 * @throws {never} Never.
 */
export function keyStanding(template: GenerationTemplate, key: TemplateNodeKey): "upstream" | "downstream" | "standalone" {
  if (!template.edges.some((edge) => edge.from === key || edge.to === key)) return "standalone";
  const above = new Set<TemplateNodeKey>([template.anchor]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const edge of template.edges) {
      if (above.has(edge.to) && !above.has(edge.from)) {
        above.add(edge.from);
        grew = true;
      }
    }
  }
  return above.has(key) ? "upstream" : "downstream";
}
