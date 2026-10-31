// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The checks a proposal answers as a whole: whether its edges run in a ring,
 * whether every source node has a place to go, and whether every node is used.
 */
import type { CanvasProposal, ProposalNode } from "@breatic/shared";

import type { ProposalVerdict } from "@domain/agent/tools/proposal-input.js";
import { refuse } from "@domain/agent/tools/proposal-refusals.js";
import {
  chosenModelOf,
  notesAsked,
  notesIn,
  routeEdges,
  waysAcrossGroup,
} from "@domain/agent/tools/proposal-routing.js";
import { waysIn } from "@domain/model-catalog/mode-catalog.js";

/**
 * Whether the edges lead anywhere, or run in a circle.
 *
 * An edge stands for one node drawing on another, so a ring of them says every
 * node waits on the next and the reader has nowhere to start.
 * @param proposal - What the model proposed.
 * @returns True when some edge leads back to where it started.
 * @throws {never} Never.
 */
export function hasRing(proposal: CanvasProposal): boolean {
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
 * @returns How many source nodes of each kind the group can take.
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
 * Whether every source node the proposal places, empty or holding material, has
 * a place to go.
 *
 * Asked of the group rather than of one generation, because a slot is filled
 * by clicking any node of its kind: an empty node placed beside one generation
 * is as reachable from the next one's panel.
 * @param proposal - The proposal being read.
 * @returns Whether it stands, and which kind is over its room when it does not.
 * @throws {never} Never.
 */
export function checkSourceNodesFit(proposal: CanvasProposal): ProposalVerdict {
  const room = placesByKind(proposal);
  const placed = new Map<string, number>();
  for (const node of proposal.nodes) {
    if (node.role !== "source") continue;
    placed.set(node.type, (placed.get(node.type) ?? 0) + 1);
  }
  for (const [kind, count] of placed) {
    const takes = room.get(kind) ?? 0;
    if (count > takes) {
      return takes === 0
        ? refuse("sources-no-taker", `This group places ${String(count)} ${kind} source node(s), and nothing in it takes ${kind} material.`)
        : refuse("sources-over-room", `This group places ${String(count)} ${kind} source node(s), and the panels in it hold ${String(takes)} at a time.`);
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
export function checkUnsentNotes(proposal: CanvasProposal): ProposalVerdict {
  const sent = new Set<ProposalNode>();
  const slotKinds = new Set<string>();
  let spare = 0;
  for (const [index, node] of proposal.nodes.entries()) {
    const chosen = chosenModelOf(node);
    if (!chosen) continue;
    for (const [kind, list] of waysIn(chosen)) {
      if (list.some((way) => way.into !== "pool")) slotKinds.add(kind);
    }
    // Every generation passed checkGenerateNode, so its edges route.
    const routing = routeEdges(proposal, index, chosen);
    if ("reason" in routing) continue;
    for (const { node: from } of routing.routed) sent.add(from);
    for (const at of Object.values(node.fills ?? {}).flat()) {
      const from = proposal.nodes[at];
      if (from) sent.add(from);
    }
    spare += notesIn(node) - notesAsked(routing.routed).length;
  }
  // Material reaches a generation only through fills or an edge into the
  // pool; held anywhere else it lands beside the work with nothing using it.
  const unused = proposal.nodes.find((node) => (node.material !== undefined || node.resource !== undefined) && !sent.has(node));
  if (unused) {
    return refuse("material-unused", `"${unused.name}" holds material that nothing here uses, and material reaches a generation only through fills or an edge into its pool. ${waysAcrossGroup(proposal, unused)}`);
  }
  const loose = proposal.nodes.filter((node) => node.role === "source" && !sent.has(node) && slotKinds.has(node.type));
  if (loose.length <= spare) return { ok: true };
  return refuse("loose-without-note", `${loose.map((n) => `"${n.name}"`).join(", ")} ${loose.length === 1 ? "goes" : "go"} into no generation, so the reader picks ${loose.length === 1 ? "it" : "each"} into a slot in the panel, and a note tells them which. The generations here carry ${String(spare)} note(s) beyond those their wired nodes use.`);
}
