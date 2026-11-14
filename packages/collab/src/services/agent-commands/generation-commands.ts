// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * An external agent's generation settings on a canvas node (breatic#1488
 * §8.1, §9), written with the writers the proposal landing and the
 * generation panel use (web's `use-node-creation.ts`, the panels' slot fill):
 * a mode or model switch resolves the node's per-model records against the
 * catalog entry the MCP service read, params land on the model in use, a
 * prompt lands as the mentions a user @'ing the node's references would
 * write, and a slot is filled from a node the way a click on it fills it.
 *
 * Everything is judged before anything is written: a plan answers a refusal
 * or the writes to run.
 */

import * as Y from "yjs";
import {
  GENERATION_NODE_MODES,
  usableUrls,
  type AgentCommandParams,
  type AgentCommandRefusal,
  type ModelEntry,
} from "@breatic/shared";
import {
  AUDIO_SLOTS,
  STYLE_SLOT,
  VIDEO_SLOTS,
  appendNodeSlotItemInDoc,
  durationOf,
  canvasNodesMap,
  deriveReferences,
  fillSlotInDoc,
  nodeDataMap,
  paramsStoreOf,
  pickedSlotUrl,
  promptMarkup,
  promptPieces,
  readEdges,
  readNodes,
  removeNodeSlotItemInDoc,
  resolveModelSwitch,
  resolveParamsEdit,
  setNodeModeInDoc,
  setNodeModelInDoc,
  setNodeParamsInDoc,
  setNodeSlotValueInDoc,
  setStoryboardShotsInDoc,
  shotsIn,
  slotFillValue,
  strongestKind,
  writeProposalPrompt,
  type ClickedNode,
  type ParamsStoreSource,
  type ProposalMention,
  type SlotSpec,
  type SpaceWriteKind,
} from "@breatic/shared/canvas-model";
import { bodyToPlainText } from "@breatic/shared/canvas/text-body";
import type { Answer, Json } from "@collab/services/agent-commands/commands.js";

/** A generation change, as `update_canvas_node` carries it. */
export type GenerationChange = NonNullable<AgentCommandParams<"update_canvas_node">["generation"]>;

/**
 * Refuse a command.
 * @param reason - Why.
 * @returns The answer.
 */
function refuse(reason: AgentCommandRefusal): Answer {
  return { status: "rejected", reason };
}

/**
 * The slots a node of this type offers on its generation panel: every one
 * either panel draws for the type, in any mode.
 * @param type - The node's type.
 * @returns Their specs.
 */
function slotsOf(type: string): SlotSpec[] {
  if (type === "image") return [STYLE_SLOT];
  if (type === "video") return [...Object.values(VIDEO_SLOTS), STYLE_SLOT];
  if (type === "audio") return Object.values(AUDIO_SLOTS);
  return [];
}

/**
 * A node as a click into a slot reads it.
 * @param doc - The canvas document.
 * @param nodeId - The node.
 * @returns What the slot fill reads, or undefined when the node is not there.
 */
function clickedNode(doc: Y.Doc, nodeId: string): ClickedNode | undefined {
  const node = canvasNodesMap(doc).get(nodeId);
  const data = node?.get("data");
  if (!node || !(data instanceof Y.Map)) return undefined;
  return { type: String(node.get("type")), data: { content: data.get("content"), coverUrl: data.get("coverUrl"), duration: data.get("duration") } };
}

/**
 * The size kind a generation change is judged by, the strongest of the kinds
 * web's writers use for its parts: mode, model, params and a single slot fill
 * edit; a prompt, lyrics and shots (the landing's batch) and a many-file
 * slot's append add; an
 * emptied slot removes.
 * @param change - The change.
 * @returns The kind.
 */
export function generationKind(change: GenerationChange): SpaceWriteKind {
  const kinds: SpaceWriteKind[] = [];
  if (change.mode !== undefined || change.model !== undefined || change.params !== undefined) kinds.push("edit");
  // The landing writes words into a node inside its `add` batch.
  if (change.prompt !== undefined || change.lyrics !== undefined || change.shots !== undefined) kinds.push("add");
  for (const value of Object.values(change.slots ?? {})) kinds.push(value === null ? "remove" : Array.isArray(value) ? "add" : "edit");
  return strongestKind(...kinds);
}

/**
 * Plan a generation change on a node: the refusal, or the writes that make it.
 * @param doc - The canvas document.
 * @param nodeId - The node, already known to be on the canvas.
 * @param type - Its type.
 * @param change - The change.
 * @returns The refusal, or the writes to run.
 */
export function planGeneration(doc: Y.Doc, nodeId: string, type: string, change: GenerationChange): Answer | (() => void) {
  const data = nodeDataMap(doc, nodeId)!;
  const writes: Array<() => void> = [];
  const modes: readonly string[] = (GENERATION_NODE_MODES as Readonly<Record<string, readonly string[]>>)[type] ?? [];
  const generates = modes.length > 0;
  const storedMode = data.get("mode");
  const storedModel = data.get("model");
  let mode = typeof storedMode === "string" ? storedMode : undefined;
  let model = typeof storedModel === "string" ? storedModel : undefined;
  let records: ParamsStoreSource = { paramsByModel: paramsStoreOf({ paramsByModel: data.get("paramsByModel") as ParamsStoreSource["paramsByModel"] }) };

  if (change.mode !== undefined || change.model !== undefined) {
    const entry = change.modelEntry as unknown as ModelEntry;
    const served = Array.isArray(entry.mode) ? entry.mode : [entry.mode];
    const target = change.mode ?? mode ?? modes.find((one) => served.includes(one));
    if (!generates || target === undefined || !modes.includes(target) || !served.includes(target)) return refuse("invalid_command");
    if (typeof entry.modality === "string" && entry.modality !== type) return refuse("invalid_command");
    const paramsByModel = resolveModelSwitch(records, entry).paramsByModel;
    mode = target;
    model = entry.name;
    records = { paramsByModel };
    const picked = entry.name;
    // As the landing does: the mode switch and the pick of the model for that
    // mode, so the pick is remembered when the user comes back to the mode.
    writes.push(() => {
      setNodeModeInDoc(doc, nodeId, target, picked, paramsByModel);
      setNodeModelInDoc(doc, nodeId, target, picked, paramsByModel);
    });
  }

  if (change.params !== undefined) {
    if (!generates || model === undefined) return refuse("invalid_command");
    const paramsByModel = resolveParamsEdit(records, change.params, model);
    records = { paramsByModel };
    writes.push(() => setNodeParamsInDoc(doc, nodeId, paramsByModel));
  }

  // A mention is written as the node's reference row names and pictures it,
  // as the landing writes one of a node already on the canvas; one list
  // serves the prompt, the lyrics and every shot.
  const mentions: ProposalMention[] = [];
  if (change.prompt !== undefined || change.lyrics !== undefined || change.shots !== undefined) {
    if (!generates) return refuse("invalid_command");
    const rail = deriveReferences(nodeId, readNodes(doc), readEdges(doc), new Map());
    for (const id of change.mentions ?? []) {
      const row = rail.find((one) => one.sourceNodeId === id);
      if (!row) return refuse("not_a_reference");
      mentions.push({
        sourceNodeId: id,
        label: row.sourceNodeName,
        kind: row.sourceNodeType,
        ...(row.thumbnail === undefined ? {} : { thumbnail: row.thumbnail }),
      });
    }
  }
  const activeMode = mode ?? modes[0];
  /**
   * What a ref at an index mentions.
   * @param index - The index into `mentions`.
   * @returns The mention.
   */
  const mentionOf = (index: number): ProposalMention | undefined => mentions[index];

  for (const [key, segments] of [["prompts", change.prompt], ["lyrics", change.lyrics]] as const) {
    if (segments === undefined) continue;
    const byMode = data.get(key);
    const fragment = byMode instanceof Y.Map && activeMode !== undefined ? byMode.get(activeMode) : undefined;
    if (!(fragment instanceof Y.XmlFragment)) return refuse("invalid_command");
    writes.push(() => writeProposalPrompt(fragment, segments, mentionOf));
  }

  if (change.shots !== undefined) {
    if (!(data.get("shots") instanceof Y.Array)) return refuse("invalid_command");
    const shots = change.shots;
    // As the landing does: fresh shots of the given seconds, then each one's words.
    writes.push(() => {
      const fragments = setStoryboardShotsInDoc(doc, nodeId, shots.map((shot) => shot.duration));
      shots.forEach((shot, i) => {
        const fragment = fragments[i];
        if (fragment) writeProposalPrompt(fragment, shot.prompt, mentionOf);
      });
    });
  }

  const offered = slotsOf(type);
  for (const [field, value] of Object.entries(change.slots ?? {})) {
    const spec = offered.find((one) => one.field === field);
    if (!spec) return refuse("invalid_command");
    if (value === null) {
      writes.push(() => setNodeSlotValueInDoc(doc, nodeId, field, null));
      continue;
    }
    const ids = Array.isArray(value) ? value : [value];
    if (!spec.multiple && ids.length !== 1) return refuse("invalid_command");
    const clicked = ids.map((id) => clickedNode(doc, id));
    if (clicked.some((one) => one === undefined)) return refuse("not_found");
    if (spec.multiple) {
      const urls = (clicked as ClickedNode[]).map((one) => pickedSlotUrl(one, spec.accepts));
      if (urls.some((url) => url === null)) return refuse("invalid_command");
      const wanted = urls as string[];
      writes.push(() => {
        // The list becomes the one named: what it should not hold goes, then
        // each file is appended as a pick appends it.
        for (const url of usableUrls(nodeDataMap(doc, nodeId)?.get(field))) {
          if (!wanted.includes(url)) removeNodeSlotItemInDoc(doc, nodeId, field, url);
        }
        for (const url of wanted) appendNodeSlotItemInDoc(doc, nodeId, field, url, wanted.length);
      });
      continue;
    }
    const source = clicked[0]!;
    if (slotFillValue(spec, source) === null) return refuse("invalid_command");
    writes.push(() => fillSlotInDoc(doc, nodeId, spec, source));
  }

  return () => {
    for (const write of writes) write();
  };
}

/**
 * Each mode's fragment under one of a node's per-mode maps, read one way.
 * @param doc - The canvas document.
 * @param nodeId - The node.
 * @param key - `prompts` or `lyrics`.
 * @param read - How to read one fragment.
 * @returns The reads, by mode.
 */
function byMode<T>(doc: Y.Doc, nodeId: string, key: "prompts" | "lyrics", read: (fragment: Y.XmlFragment) => T): Record<string, T> {
  const map = nodeDataMap(doc, nodeId)?.get(key);
  const out: Record<string, T> = {};
  if (!(map instanceof Y.Map)) return out;
  map.forEach((fragment, mode) => {
    if (fragment instanceof Y.XmlFragment) out[mode] = read(fragment);
  });
  return out;
}

/**
 * A video node's storyboard shots, each prompt read one way.
 * @param doc - The canvas document.
 * @param nodeId - The node.
 * @param read - How to read one shot's prompt.
 * @returns The shots in order, or undefined when the node has no list of shots.
 */
function shotsOf<T>(doc: Y.Doc, nodeId: string, read: (fragment: Y.XmlFragment) => T): Array<{ duration: number; prompt: T }> | undefined {
  const shots = shotsIn(doc, nodeId);
  if (!shots) return undefined;
  return shots.toArray().flatMap((shot) => {
    const prompt = shot.get("prompt");
    return prompt instanceof Y.XmlFragment ? [{ duration: durationOf(shot), prompt: read(prompt) }] : [];
  });
}

/**
 * The words of a node's generation as an external agent reads them: each
 * mode's prompt and lyrics, each mention as `@[label](node id)`, and the
 * storyboard's shots. Empty prompts and lyrics, and an empty storyboard, are
 * left out.
 * @param doc - The canvas document.
 * @param nodeId - The node.
 * @returns What to add to the node's view.
 */
export function generationWordsOf(
  doc: Y.Doc,
  nodeId: string,
): { prompts?: Record<string, string>; lyrics?: Record<string, string>; shots?: Array<{ duration: number; prompt: string }> } {
  /**
   * The non-empty entries of a by-mode read.
   * @param read - The read.
   * @returns It without empty entries, or undefined when none is left.
   */
  const written = (read: Record<string, string>): Record<string, string> | undefined => {
    const kept = Object.fromEntries(Object.entries(read).filter(([, text]) => text !== ""));
    return Object.keys(kept).length > 0 ? kept : undefined;
  };
  const prompts = written(byMode(doc, nodeId, "prompts", promptMarkup));
  const lyrics = written(byMode(doc, nodeId, "lyrics", promptMarkup));
  const shots = shotsOf(doc, nodeId, promptMarkup);
  return {
    ...(prompts ? { prompts } : {}),
    ...(lyrics ? { lyrics } : {}),
    ...(shots && shots.length > 0 ? { shots } : {}),
  };
}

/**
 * What a node's generation panel builds its view model from, read before a
 * run so the MCP service can build the body the browser would send: the node
 * and every node wired into it, the edges into it, the words of each text
 * node wired in, each mode's prompt and lyrics as pieces, and the storyboard's
 * shots with their prompts as pieces.
 * @param doc - The canvas document.
 * @param nodeId - The node.
 * @returns The answer.
 */
export function readGenerationInputs(doc: Y.Doc, nodeId: string): Answer {
  const all = readNodes(doc);
  const target = all.find((node) => node.id === nodeId);
  if (!target) return refuse("not_found");
  const edges = readEdges(doc).filter((edge) => edge.target === nodeId);
  const sources = new Set(edges.map((edge) => edge.source));
  const nodes = all.filter((node) => node.id === nodeId || sources.has(node.id));
  const textById: Record<string, string> = {};
  for (const node of nodes) {
    if (node.id === nodeId || node.type !== "text") continue;
    const body = nodeDataMap(doc, node.id)?.get("body");
    textById[node.id] = body instanceof Y.XmlFragment ? bodyToPlainText(body) : "";
  }
  const prompts = byMode(doc, nodeId, "prompts", promptPieces);
  const lyrics = byMode(doc, nodeId, "lyrics", promptPieces);
  const shots = shotsOf(doc, nodeId, promptPieces) ?? [];
  // The views hold no value JSON cannot carry except `undefined`, which the
  // round trip drops.
  return { status: "done", result: JSON.parse(JSON.stringify({ nodes, edges, textById, prompts, lyrics, shots })) as Json };
}
