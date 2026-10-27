// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

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
  type TemplateGraphNode,
  type TemplateInstanceMatch,
  type TemplateNodeKey,
} from "@breatic/shared";

import type { ProposalVerdict } from "@domain/agent/tools/proposal-input.js";
import { fixOn, nodeLabel, refuse, type NodeFix } from "@domain/agent/tools/proposal-refusals.js";
import type { TemplatePlace } from "@domain/agent/tools/template-expansion.js";

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
      if ("input" in place) return [id, { id, type: node.type, inputTag: { template: place.template.id, input: place.input }, keeps: true }];
      const tag = place.anchor ? {} : { tag: { template: place.template.id, key: place.key } };
      return [id, { id, type: node.type, ...tag, keeps: keeps(proposal, index, place) }];
    }),
  );
  const incoming = new Map<string, { from: string; into?: string }[]>();
  for (const edge of proposal.edges) {
    const to = String(edge.toIndex);
    incoming.set(to, [...(incoming.get(to) ?? []), edge.into === undefined ? { from: String(edge.fromIndex) } : { from: String(edge.fromIndex), into: edge.into }]);
  }
  return places.flatMap((place, anchor): AnchoredInstance[] => {
    if (place === undefined || "input" in place || !place.anchor) return [];
    return [{ anchor, place, match: matchTemplateInstance(templateSkeleton(place.template), { nodes, incoming }, String(anchor)) }];
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
     * The fix that wires one node into another the way a template edge does.
     * @param from - The index of the node to wire in.
     * @param to - The index of the node it goes into.
     * @param into - Where on that node it goes.
     * @returns The fix.
     */
    const wireFix = (from: number, to: number, into: string): NodeFix => {
      const where = proposal.nodes[to]?.shots !== undefined ? "a shot" : "the prompt";
      const mention = into === "pool" ? `, and @ ${nodeLabel(proposal.nodes, from)} with a ref in ${where}` : "";
      return fixOn(nodeLabel(proposal.nodes, to), `take an edge from ${nodeLabel(proposal.nodes, from)} into "${into}"${mention}.`);
    };
    for (const [key, found] of match.keys) {
      if (found.kind === "many") {
        return refuse("template-key-repeated", `Template "${id}" anchored at ${at} takes one "${key}" node, and ${found.nodes.map(label).join(", ")} are each wired in where it goes.`);
      }
      if (found.kind !== "missing") continue;
      const candidates = match.candidates.get(key) ?? [];
      const edge = match.walked.find((one) => one.from === key);
      const only = candidates[0];
      const into = edge?.into ?? "pool";
      const to = edge === undefined ? undefined : indexAt(edge.to);
      if (candidates.length === 1 && only !== undefined && edge !== undefined && to !== undefined) {
        return refuse(
          "template-edge-missing",
          `Template "${id}" anchored at ${at} wires its "${key}" node into "${edge.to}" by "${into}", and ${label(only)}, tagged "${key}", has no edge there.`,
          wireFix(Number(only), to, into),
        );
      }
      const own = place.template.nodes.find((node) => node.key === key);
      const where = to === undefined ? `its "${edge?.to ?? ""}" node` : nodeLabel(proposal.nodes, to);
      const listed = candidates.length === 0 ? "" : ` Nodes tagged "${key}" that are wired nowhere it goes: ${candidates.map(label).join(", ")}.`;
      return refuse(
        "template-key-missing",
        `Template "${id}" anchored at ${at} wires a ${own?.role ?? ""} ${own?.type ?? ""} "${key}" node into ${where} by "${into}", and none is wired in there.${listed}`,
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
          wireFix(from, to, into),
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
        fixOn(nodeLabel(proposal.nodes, to), `send the edge from ${nodeLabel(proposal.nodes, from)} into "${want}".`),
      );
    }
    const missing = match.unassigned[0];
    if (missing !== undefined) {
      const input = place.template.inputs.find((one) => one.key === missing.input);
      const fed = missing.fed === place.template.anchor ? at : label(nodeIdOf(match, missing.fed));
      return refuse("template-input-missing", `Template "${id}" takes input "${missing.input}" on ${fed}, and no ${input?.type ?? ""} node of its own is wired in there.`);
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
