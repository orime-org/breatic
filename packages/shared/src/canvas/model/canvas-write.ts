// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The bodies of every canvas Space write (breatic#1488 §8.1): what lands in
 * the document, with the structure and rules web has always used, so collab
 * writes a canvas exactly the way the browser does.
 *
 * A body takes the `Y.Doc` and the write's arguments and performs the writes
 * only. It never opens a transaction or judges the Space's size: the caller
 * owns both, and the origin it transacts under (web: `CANVAS_UNDO` for user
 * edits the undo manager tracks, `CONTENT_WRITE` for content arrivals). In
 * web every call of a body sits in a `writeSpaceDoc` / `runCanvasUndoBatch`
 * callback; `breatic/space-doc-write-gateway` lists these names in
 * `writeFunctions`.
 *
 * Frontend owns node create / delete / position + edges. Backend (Worker via
 * Collab) only sets state fields inside the node's `data` Y.Map. The nested
 * `data` Y.Map is load-bearing: collab's task-listener reaches
 * `nodesMap.get(nodeId).get("data")` and asserts `instanceof Y.Map` before
 * writing the worker's result back.
 */

import * as Y from 'yjs';

import { usableUrls } from '@shared/item-cap.js';
import { bodyFromText, writePlainTextIntoBody } from '@shared/canvas/text-body.js';
import { writeNodeMedia, type NodeMediaFields } from '@shared/canvas/node-media.js';
import { AUDIO_GENERATION_MODES, GENERATION_NODE_MODES } from '@shared/types/model-catalog.js';
import {
  canGenerate,
  type AnnotationAssignment,
  type AnnotationReply,
  type CanvasNodeFields,
  type CommentMention,
  type FocusImage,
  type NodeType,
} from '@shared/types/canvas-node.js';
import { MAX_FOCUS_ENTRIES, validFocusImages } from '@shared/canvas/model/focus-images.js';
import { fillNestedData, splitSnapshot } from '@shared/canvas/model/node-data-snapshot.js';
import type { CanvasEdge } from '@shared/canvas/model/node-view.js';
import {
  annotationEditTarget,
  canvasEdgesMap,
  canvasNodesMap,
  groupEntry,
  nodeDataMap,
  repliesArray,
  replyIndex,
} from '@shared/canvas/model/canvas-read.js';

/**
 * Build the nested `data` Y.Map for a node from a plain wire data object.
 * Each defined field becomes a Y.Map entry (plain values — strings,
 * numbers, booleans, plain arrays / objects — matching how the backend
 * reads `taskCounts` as a plain object). Undefined fields are omitted.
 *
 * Some keys are exceptions to the plain-values convention, and every one of
 * them is seeded here rather than on demand. A container created on demand is a
 * whole-container race: two clients that both find it missing each mint their
 * own, map-level last-write-wins keeps one, and the loser's content disappears
 * with their container. Born inside the creating transaction the container is
 * a single replicated creation event, every edit inside it commutes, and
 * undoing the creation takes the container along instead of orphaning it.
 *
 * `focusImages` — a `Y.Array` CRDT sequence on EVERY node (concurrent-add
 * safe, see {@link appendFocusImageCore}), seeded from a provided wire value
 * else empty; the two focus writers maintain it (the backend never reads the
 * field, and `toJSON()` serializes both encodings identically).
 *
 * `body` — a text node's shared fragment, what its editor binds to (#1774).
 * Seeded non-empty, because the editor's schema wants at least one block.
 *
 * `prompts` — one Generate prompt fragment per mode, on the modalities that
 * offer Generate (#1880, #2218). Seeded empty; web's `getPromptFragment` only
 * reads.
 *
 * `lyrics` — one lyrics fragment per audio mode, the words to sing beside the
 * style brief (#1960, #2218). Seeded empty; web's `getLyricsFragment` only
 * reads.
 *
 * `shots` — the video node's shots, empty, which only the multi-shot mode
 * uses; `storyboard-shots.ts` reads and edits it.
 * @param data - The plain wire data fields to write.
 * @param type - The node's modality, which decides which containers are
 *   seeded: `body` for text, `prompts` for generate-capable modalities,
 *   `lyrics` for audio, `shots` for video, and `replies` for an
 *   annotation.
 * @returns A Y.Map populated with the defined data fields.
 */
export function buildDataMap(
  data: CanvasNodeFields['data'],
  type: NodeType,
): Y.Map<unknown> {
  const map = new Y.Map<unknown>();
  // Tracked with a local flag, NOT `map.has()` — reads on a not-yet
  // integrated Y.Map do not see preliminary content, so `has` would
  // always answer false here and the eager-seed below would overwrite a
  // just-seeded array with an empty one.
  let focusSeeded = false;
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined) continue;
    // A text node's words go into its shared body below, never into a plain
    // field. Every creation path that arrives with text — a paste, a copied
    // node, a dropped file — hands it over as `content`, because that is what
    // fits through a clipboard; this is where it stops being a plain string.
    if (key === 'content' && type === 'text') continue;
    if (key === 'focusImages' && Array.isArray(value)) {
      // Seed the CRDT sequence from a provided wire value AS-IS (no
      // sanitizing — readers sanitize; a fixture / forged value must be
      // representable so the read-side defenses stay testable).
      const arr = new Y.Array<unknown>();
      arr.push([...value]);
      map.set(key, arr);
      focusSeeded = true;
      continue;
    }
    map.set(key, value);
  }
  // Eager-seed the crops container at node BIRTH (design adversary
  // 2026-07-17): creating it lazily on the first append is itself a
  // whole-container LWW race — two clients cropping a cropless node
  // concurrently would each create their own Y.Array under the key and
  // one container would vanish WITH its crop. Born-with-the-node, the
  // container is a single replicated creation event and every append
  // everywhere commutes. Readers see `focusImages: []` (inert). A
  // non-array wire value under the key is overwritten by the empty
  // container — shape sanitation at birth.
  if (!focusSeeded) map.set('focusImages', new Y.Array<unknown>());
  // Non-empty from birth: the editor's schema wants at least one block, and a
  // body that disagrees loses the redo stack the first time an undo empties it
  // (`document-body` states the same invariant for document Space bodies).
  if (type === 'text') {
    const text = typeof data.content === 'string' ? data.content : '';
    map.set('body', bodyFromText(text));
  }
  // #1880. Replayed against the old lazy-create code through the public API,
  // the merge kept one client's line and the other's vanished outright — the
  // race the header describes, observed rather than reasoned about. Only the
  // modalities that offer Generate get one; on a group or a sticky it would be
  // a container nothing ever reads.
  // One prompt per mode (#2218): switching mode switches to that mode's own
  // words, and every mode's container is born here for the #1880 reason.
  if (canGenerate(type)) {
    map.set('prompts', fragmentsFor(GENERATION_NODE_MODES[type as keyof typeof GENERATION_NODE_MODES] ?? []));
  }
  // Every audio mode gets lyrics: which modes' models take them is a catalog
  // fact this birth does not know, and a container born later would race.
  if (type === 'audio') map.set('lyrics', fragmentsFor(AUDIO_GENERATION_MODES));
  // The multi-shot mode's shots. Each shot is inserted whole with its own
  // fragment, so concurrent adds both survive.
  if (type === 'video') map.set('shots', new Y.Array<Y.Map<unknown>>());
  // Same reasoning as the crops container, and the same race #1880 recorded:
  // two people replying to an annotation that has none would each create a
  // Y.Array under this key and the merge would keep one, taking a reply with
  // it. Born with the node, every append everywhere commutes. Nothing arrives
  // over the wire carrying `replies` — annotations are not creatable through
  // the clipboard, and every other birth path builds its data fresh.
  if (type === 'annotation') map.set('replies', new Y.Array<Y.Map<unknown>>());
  return map;
}

/**
 * One empty fragment per mode, keyed by mode.
 * @param modes - The modes to seed.
 * @returns The map of fragments.
 */
export function fragmentsFor(modes: readonly string[]): Y.Map<Y.XmlFragment> {
  const out = new Y.Map<Y.XmlFragment>();
  for (const mode of modes) out.set(mode, new Y.XmlFragment());
  return out;
}

/** A node to write from a clipboard snapshot: `data` is `snapshotNodeData`'s output. */
export interface SnapshotNode {
  id: string;
  type: string;
  position: { x: number; y: number };
  parentId?: string;
  data: Record<string, unknown>;
}

/**
 * One node's entry in `nodesMap`, holding a data map built for its type.
 * @param node - The node's id, type, position and Group link.
 * @param data - Its data map.
 * @returns The entry.
 */
export function nodeEntry(node: Omit<SnapshotNode, 'data'>, data: Y.Map<unknown>): Y.Map<unknown> {
  const map = new Y.Map<unknown>();
  map.set('id', node.id);
  map.set('type', node.type);
  // Group containment: persist the member→Group link as a top-level field
  // (alongside position), only when set so top-level nodes carry no key.
  if (node.parentId !== undefined) map.set('parentId', node.parentId);
  map.set('position', node.position);
  map.set('data', data);
  return map;
}

/**
 * Add a node: the wire `CanvasNodeFields` shape (a node Y.Map with a nested
 * `data` Y.Map) under `nodesMap`.
 * @param doc - The canvas document.
 * @param node - The wire node fields (id, type, position, data) to insert.
 */
export function addNodeInDoc(doc: Y.Doc, node: CanvasNodeFields): void {
  canvasNodesMap(doc).set(node.id, nodeEntry(node, buildDataMap(node.data, node.type)));
}

/**
 * Write nodes and edges carried by a clipboard snapshot (inner#1349, design
 * 5.3). Each node is born through the same path as {@link addNodeInDoc}, so
 * every container a node of its type needs exists from birth; the snapshot's
 * nested structures are then filled into those containers once the node is in
 * the document, where they can be read. Edges whose ends are not both in the
 * document are skipped.
 * @param doc - The canvas document (a live Space, or a throwaway doc).
 * @param nodes - The nodes, groups before their members.
 * @param edges - The edges, each with its `createdAt`.
 */
export function writeSnapshotNodesInDoc(
  doc: Y.Doc,
  nodes: ReadonlyArray<SnapshotNode>,
  edges: ReadonlyArray<CanvasEdge>,
): void {
  const nodesMap = canvasNodesMap(doc);
  const edgesMap = canvasEdgesMap(doc);
  for (const node of nodes) {
    const { plain, nested } = splitSnapshot(node.data);
    const type = node.type as NodeType;
    // A text node's words arrive in its body tree; `content` would seed the
    // body a second time.
    if (type === 'text') delete plain.content;
    const data = buildDataMap(plain as CanvasNodeFields['data'], type);
    nodesMap.set(node.id, nodeEntry(node, data));
    fillNestedData(data, nested);
  }
  for (const edge of edges) putEdge(nodesMap, edgesMap, edge);
}

/**
 * Within an open transaction, release a Group's members before it is deleted:
 * clear each member's `parentId` and convert its parent-relative position back
 * to absolute. Deleting a Group never deletes its members — they become
 * top-level nodes. Members deleted in the same call are skipped: rewriting a
 * node about to go would turn a pure removal into a compound one (design 5.2).
 * No-op when the group has no resolvable position.
 * @param nodesMap - The canvas-space `nodesMap` (call inside a transaction).
 * @param groupId - The Group node being deleted.
 * @param deleted - Every node deleted in the same call.
 */
export function releaseGroupMembers(
  nodesMap: Y.Map<Y.Map<unknown>>,
  groupId: string,
  deleted: ReadonlySet<string>,
): void {
  const group = nodesMap.get(groupId);
  if (!(group instanceof Y.Map)) return;
  const groupPos = group.get('position') as { x: number; y: number } | undefined;
  nodesMap.forEach((node, id) => {
    if (!(node instanceof Y.Map) || node.get('parentId') !== groupId || deleted.has(id)) return;
    if (groupPos) {
      const p = node.get('position') as { x: number; y: number } | undefined;
      if (p) node.set('position', { x: p.x + groupPos.x, y: p.y + groupPos.y });
    }
    node.delete('parentId');
  });
}

/**
 * Delete a node by id. Deleting a Group first releases its members (clears
 * `parentId`, restores absolute position) so they survive as top-level nodes.
 * @param doc - The canvas document.
 * @param nodeId - Id of the node to delete.
 */
export function removeNodeInDoc(doc: Y.Doc, nodeId: string): void {
  const nodesMap = canvasNodesMap(doc);
  const node = nodesMap.get(nodeId);
  if (node instanceof Y.Map && node.get('type') === 'group') {
    releaseGroupMembers(nodesMap, nodeId, new Set([nodeId]));
  }
  nodesMap.delete(nodeId);
}

/**
 * Delete nodes and edges together, each Group releasing the members that stay.
 * @param doc - The canvas document.
 * @param nodeIds - Node ids to delete.
 * @param edgeIds - Edge ids to delete.
 */
export function removeElementsInDoc(
  doc: Y.Doc,
  nodeIds: ReadonlyArray<string>,
  edgeIds: ReadonlyArray<string>,
): void {
  const nodesMap = canvasNodesMap(doc);
  const edgesMap = canvasEdgesMap(doc);
  const deleted = new Set(nodeIds);
  nodeIds.forEach((id) => {
    const node = nodesMap.get(id);
    if (node instanceof Y.Map && node.get('type') === 'group') {
      releaseGroupMembers(nodesMap, id, deleted);
    }
    nodesMap.delete(id);
  });
  edgeIds.forEach((id) => edgesMap.delete(id));
}

/**
 * Whether a position measured against `parentId` may be written onto a node:
 * the node is there and still belongs to that Group (or to none, for null).
 * @param doc - The canvas document.
 * @param nodeId - The node.
 * @param parentId - The Group the position is measured against, or null.
 * @returns Whether the write applies.
 */
export function positionApplies(doc: Y.Doc, nodeId: string, parentId: string | null): boolean {
  const node = canvasNodesMap(doc).get(nodeId);
  return !!node && (node.get('parentId') ?? null) === parentId;
}

/**
 * Update a node's position (drag end). No-op when the node is gone or has
 * left the Group the position is measured against.
 * @param doc - The canvas document.
 * @param nodeId - Id of the node to reposition.
 * @param position - The node's new canvas coordinates.
 * @param position.x - New x coordinate.
 * @param position.y - New y coordinate.
 * @param parentId - The Group the position is measured against, or null.
 */
export function setNodePositionInDoc(
  doc: Y.Doc,
  nodeId: string,
  position: { x: number; y: number },
  parentId: string | null,
): void {
  if (!positionApplies(doc, nodeId, parentId)) return;
  canvasNodesMap(doc).get(nodeId)?.set('position', position);
}

/**
 * Rename a node, inside its nested `data` Y.Map so the change merges
 * field-wise with concurrent collaborator / backend writes.
 * @param doc - The canvas document.
 * @param nodeId - Id of the node to rename.
 * @param name - The node's new display name.
 */
export function setNodeNameInDoc(doc: Y.Doc, nodeId: string, name: string): void {
  nodeDataMap(doc, nodeId)?.set('name', name);
}

/**
 * Mark a node as the generation template node it was placed as (inner#1345).
 * @param doc - The canvas document.
 * @param nodeId - The node.
 * @param templateNode - The template, its key, and on a guide or input node the anchor's id; `input` on an input node.
 */
export function setNodeTemplateNodeInDoc(
  doc: Y.Doc,
  nodeId: string,
  templateNode: NonNullable<CanvasNodeFields['data']['templateNode']>,
): void {
  nodeDataMap(doc, nodeId)?.set('templateNode', { ...templateNode });
}

/**
 * Lock / unlock a node. Unlocking deletes the key; readers treat only
 * `=== true` as locked (design 5.2).
 * @param doc - The canvas document.
 * @param nodeId - Id of the node to lock / unlock.
 * @param locked - The node's new lock state.
 */
export function setNodeLockedInDoc(doc: Y.Doc, nodeId: string, locked: boolean): void {
  const data = nodeDataMap(doc, nodeId);
  if (!data) return;
  if (locked) data.set('locked', true);
  else data.delete('locked');
}

/**
 * Append a reply to an annotation. Appending is all a reply ever does to the
 * sequence, so two people answering at once keep both answers; the container
 * they append to was born with the node (see {@link buildDataMap}).
 * @param doc - The canvas document.
 * @param nodeId - Id of the annotation being replied to.
 * @param reply - The reply to post.
 * @returns Whether it was appended; false when the annotation is gone.
 */
export function addReplyInDoc(doc: Y.Doc, nodeId: string, reply: AnnotationReply): boolean {
  const replies = repliesArray(doc, nodeId);
  if (!replies) return false;
  const map = new Y.Map<unknown>();
  map.set('id', reply.id);
  map.set('content', reply.content);
  map.set('createdBy', reply.createdBy);
  map.set('createdAt', reply.createdAt);
  if (reply.via !== undefined) map.set('via', reply.via);
  if (reply.answers !== undefined) map.set('answers', reply.answers);
  writeMentions(map, reply.mentions);
  replies.push([map]);
  return true;
}

/**
 * Rewrite an annotation's body and stamp when; `createdAt` and `createdBy`
 * are left alone.
 * @param doc - The canvas document.
 * @param nodeId - Id of the annotation to rewrite.
 * @param content - The new body, as markdown source.
 * @param editedAt - When this edit happened, epoch milliseconds.
 * @param mentions - The members the new body mentions; left as they were when absent.
 * @returns Whether it was rewritten; false when the annotation is gone.
 */
export function editAnnotationBodyInDoc(
  doc: Y.Doc,
  nodeId: string,
  content: string,
  editedAt: number,
  mentions?: readonly CommentMention[],
): boolean {
  const data = annotationEditTarget(doc, nodeId, null);
  if (!data) return false;
  data.set('content', content);
  data.set('editedAt', editedAt);
  writeMentions(data, mentions);
  return true;
}

/**
 * Rewrite one reply and stamp when.
 * @param doc - The canvas document.
 * @param nodeId - Id of the annotation the reply hangs under.
 * @param replyId - Id of the reply to rewrite.
 * @param content - The new body, as markdown source.
 * @param editedAt - When this edit happened, epoch milliseconds.
 * @param mentions - The members the new reply mentions; left as they were when absent.
 * @returns Whether it was rewritten; false when the reply is gone.
 */
export function editReplyInDoc(
  doc: Y.Doc,
  nodeId: string,
  replyId: string,
  content: string,
  editedAt: number,
  mentions?: readonly CommentMention[],
): boolean {
  const reply = annotationEditTarget(doc, nodeId, replyId);
  if (!reply) return false;
  reply.set('content', content);
  reply.set('editedAt', editedAt);
  writeMentions(reply, mentions);
  return true;
}

/**
 * Hand a thread to an external agent, or take it back (#1488 §11.7).
 * @param doc - The canvas document.
 * @param nodeId - Id of the annotation.
 * @param assignment - Who it is handed to; null removes the hand-over.
 * @returns Whether it was written; false when the annotation is gone.
 */
export function setAnnotationAssignmentInDoc(doc: Y.Doc, nodeId: string, assignment: AnnotationAssignment | null): boolean {
  const data = annotationEditTarget(doc, nodeId, null);
  if (!data) return false;
  if (assignment === null) data.delete('assignment');
  else data.set('assignment', { ...assignment });
  return true;
}

/**
 * Store an entry's mentions beside its words (#1488 §11.6): replaced when
 * given, the key dropped when none are left, untouched when absent.
 * @param entry - The annotation's data or one reply.
 * @param mentions - The members it mentions.
 */
function writeMentions(entry: Y.Map<unknown>, mentions: readonly CommentMention[] | undefined): void {
  if (mentions === undefined) return;
  if (mentions.length > 0) entry.set('mentions', mentions.map((m) => ({ ...m })));
  else if (entry.has('mentions')) entry.delete('mentions');
}

/**
 * Delete one reply; no-op when it is already gone. The index is resolved from
 * the id against the live sequence, so a concurrent insert cannot make this
 * delete the wrong reply.
 * @param doc - The canvas document.
 * @param nodeId - Id of the annotation the reply hangs under.
 * @param replyId - Id of the reply to delete.
 */
export function removeReplyInDoc(doc: Y.Doc, nodeId: string, replyId: string): void {
  const replies = repliesArray(doc, nodeId);
  if (!replies) return;
  const index = replyIndex(replies, replyId);
  if (index === -1) return;
  replies.delete(index, 1);
}

/**
 * Set a content node's Generate model params — every per-model record (#1948),
 * written WHOLE, not merged: which model an edit belongs to is something only
 * the caller knows.
 * @param doc - The canvas document.
 * @param nodeId - Id of the node whose params to set.
 * @param paramsByModel - Every per-model record to persist.
 */
export function setNodeParamsInDoc(
  doc: Y.Doc,
  nodeId: string,
  paramsByModel: Record<string, Record<string, unknown>>,
): void {
  nodeDataMap(doc, nodeId)?.set('paramsByModel', paramsByModel);
}

/**
 * Write a slot's pick onto a node's data map — the whole pick, one key, so
 * two clients picking at once never converge per-key into one client's asset
 * wearing the other's poster. `null` deletes the key: "none picked" is the
 * key's absent state.
 * @param doc - The canvas document.
 * @param nodeId - Id of the node whose slot to write.
 * @param key - The data-map key this slot owns.
 * @param value - The pick to store, or `null` to empty the slot.
 */
export function setNodeSlotValueInDoc(
  doc: Y.Doc,
  nodeId: string,
  key: string,
  value: string | Readonly<Record<string, string | number>> | null,
): void {
  const data = nodeDataMap(doc, nodeId);
  if (!data) return;
  if (value === null) {
    if (data.has(key)) data.delete(key);
  } else {
    data.set(key, value);
  }
}

/**
 * Adds one file to a slot that holds several (inner#826: style images). The
 * list is one value, read and written in one go; when two users append at the
 * same moment, Yjs keeps one whole list, so one of the two appends is lost.
 * @param doc - The canvas document.
 * @param nodeId - The generative node whose slot gets the file.
 * @param key - The node data field the slot owns.
 * @param url - The picked file's URL.
 * @param capacity - The most files the slot holds.
 * @returns What happened: added, added and now full, already there, full, or no such node.
 */
export function appendNodeSlotItemInDoc(
  doc: Y.Doc,
  nodeId: string,
  key: string,
  url: string,
  capacity: number,
): 'added' | 'filled' | 'present' | 'full' | 'node-missing' {
  const data = nodeDataMap(doc, nodeId);
  if (!data) return 'node-missing';
  const list = usableUrls(data.get(key));
  if (list.includes(url)) return 'present';
  if (list.length >= capacity) return 'full';
  data.set(key, [...list, url]);
  return list.length + 1 >= capacity ? 'filled' : 'added';
}

/**
 * A multi-file slot's files without one of them.
 * @param data - The node's data map.
 * @param key - The node data field the slot owns.
 * @param url - The file to take out.
 * @returns The files that stay.
 */
export function slotItemsWithout(data: Y.Map<unknown>, key: string, url: string): string[] {
  return usableUrls(data.get(key)).filter((u) => u !== url);
}

/**
 * Takes one file out of a slot that holds several; the field goes with the
 * last one, so an empty slot reads the same as one never filled.
 * @param doc - The canvas document.
 * @param nodeId - The generative node whose slot loses the file.
 * @param key - The node data field the slot owns.
 * @param url - The file to take out.
 */
export function removeNodeSlotItemInDoc(doc: Y.Doc, nodeId: string, key: string, url: string): void {
  const data = nodeDataMap(doc, nodeId);
  if (!data) return;
  const next = slotItemsWithout(data, key, url);
  if (next.length === 0) data.delete(key);
  else data.set(key, next);
}

/**
 * Read the focusImages value in either encoding — the CRDT `Y.Array`
 * (what the writers below maintain) or a plain array (a first-write-era
 * doc or forged wire data) — as a plain snapshot for the sanitizer.
 * @param raw - The raw `focusImages` value off the data Y.Map.
 * @returns A plain snapshot the shared sanitizer can consume.
 */
function focusImagesSnapshot(raw: unknown): unknown {
  return raw instanceof Y.Array ? raw.toArray() : raw;
}

/**
 * Append a focus crop — call inside an open transaction.
 *
 * `focusImages` is a `Y.Array` of plain `FocusImage` objects (design
 * adversary 2026-07-17): a CRDT SEQUENCE, not a whole-array LWW register —
 * two clients cropping the same node concurrently must BOTH keep their
 * crops (the ratified soft-cap model assumes concurrent adds survive as
 * overshoot), and a whole-array `set` made the loser's crop vanish after
 * sync with its asset already uploaded and its ledger row already reported.
 * The wire/JSON shape is unchanged (`dataMap.toJSON()` serializes a
 * `Y.Array` to the same plain array), so every reader stays as-is. A plain
 * array value (first-write-era doc / forged wire) is converted — sanitized
 * through {@link validFocusImages} — into a `Y.Array` on the first write.
 *
 * The appended entry rides the SAME sanitizer (round-5) AND the same COUNT
 * ceiling (round-7): an entry the readers would reject must never be
 * written. The ceiling check reads the local snapshot, so truly concurrent
 * appends at the ceiling can overshoot it — the reader's `slice` hides the
 * tail; accepted as the hard-ceiling analogue of the ratified pool-cap
 * overshoot (reaching it needs the pool knob raised above 200 first).
 * @param data - The node's data Y.Map.
 * @param image - The focus crop to append.
 * @returns 'added' on success; 'invalid-entry' / 'pool-full' refusals.
 */
export function appendFocusImageCore(
  data: Y.Map<unknown>,
  image: FocusImage,
): 'added' | 'invalid-entry' | 'pool-full' {
  const raw = data.get('focusImages');
  const list = validFocusImages(focusImagesSnapshot(raw));
  const appended = validFocusImages([image]);
  if (appended.length === 0) return 'invalid-entry';
  if (list.length >= MAX_FOCUS_ENTRIES) return 'pool-full';
  if (raw instanceof Y.Array) {
    (raw as Y.Array<FocusImage>).push(appended);
  } else {
    // One-time conversion: seed from the sanitized snapshot (heals a
    // malformed plain value in the same write).
    const arr = new Y.Array<FocusImage>();
    arr.push([...list, ...appended]);
    data.set('focusImages', arr);
  }
  return 'added';
}

/**
 * Remove a focus crop by id — call inside an open transaction. On the
 * `Y.Array` encoding it deletes the target entries in place (commutes with a
 * concurrent append / a concurrent removal of a DIFFERENT crop — both effects
 * survive the merge); malformed remote entries stay in the CRDT and are the
 * readers' problem (every reader sanitizes through {@link validFocusImages}).
 * The array is kept when the last entry goes: deleting the KEY would be a
 * map-level write racing a concurrent push — the pushed crop would land in a
 * deleted subtree and vanish, the exact loss mode this encoding exists to
 * remove. A plain array value (first-write-era doc / forged wire) is
 * converted — sanitized — into a `Y.Array` on the way through.
 * @param data - The node's data Y.Map.
 * @param focusId - Id of the focus crop to remove.
 * @returns True only when the TARGET crop was actually removed.
 */
export function removeFocusImageCore(data: Y.Map<unknown>, focusId: string): boolean {
  const raw = data.get('focusImages');
  if (raw instanceof Y.Array) {
    let removed = false;
    for (let i = raw.length - 1; i >= 0; i--) {
      const item: unknown = raw.get(i);
      if (
        item !== null &&
        typeof item === 'object' &&
        (item as { id?: unknown }).id === focusId
      ) {
        raw.delete(i, 1);
        removed = true;
      }
    }
    return removed;
  }
  if (!Array.isArray(raw)) return false;
  // Sanitize BEFORE dereferencing — a null/primitive entry from a remote
  // client used to throw on `f.id` here (adversarial 2026-07-16).
  const list = validFocusImages(raw);
  const next = list.filter((f) => f.id !== focusId);
  const removed = next.length !== list.length;
  if (!removed && list.length === raw.length) return false;
  const arr = new Y.Array<FocusImage>();
  arr.push(next);
  data.set('focusImages', arr);
  return removed;
}

/**
 * Append a focus crop to a node's `focusImages` (#1782).
 * @param doc - The canvas document.
 * @param nodeId - Id of the generative node the crop belongs to.
 * @param image - The focus crop to append.
 * @returns 'added', or why not: 'node-missing', 'invalid-entry', 'pool-full'.
 */
export function addNodeFocusImageInDoc(
  doc: Y.Doc,
  nodeId: string,
  image: FocusImage,
): 'added' | 'node-missing' | 'invalid-entry' | 'pool-full' {
  const data = nodeDataMap(doc, nodeId);
  if (!data) return 'node-missing';
  return appendFocusImageCore(data, image);
}

/**
 * Remove a focus crop from a node's `focusImages` by id (#1782).
 * @param doc - The canvas document.
 * @param nodeId - Id of the generative node the crop belongs to.
 * @param focusId - Id of the focus crop to remove.
 * @returns True only when the TARGET crop was actually removed.
 */
export function removeNodeFocusImageInDoc(doc: Y.Doc, nodeId: string, focusId: string): boolean {
  const data = nodeDataMap(doc, nodeId);
  if (!data) return false;
  return removeFocusImageCore(data, focusId);
}

/**
 * The fields picking a model writes: the model, every per-model record, and
 * the pick remembered under the mode.
 * @param data - The node's data map.
 * @param mode - The active mode.
 * @param model - The picked model.
 * @param paramsByModel - Every per-model record, written whole.
 * @returns The fields.
 */
export function modelPickFields(
  data: Y.Map<unknown>,
  mode: string,
  model: string,
  paramsByModel: Record<string, Record<string, unknown>>,
): { model: string; paramsByModel: Record<string, Record<string, unknown>>; modelByMode: Record<string, string> } {
  const prev = data.get('modelByMode');
  const base =
    prev != null && typeof prev === 'object'
      ? (prev as Record<string, string>)
      : {};
  return { model, paramsByModel, modelByMode: { ...base, [mode]: model } };
}

/**
 * Switch a content node's Generate model: the new model id, the per-model
 * records, and the active mode's remembered model, together.
 * @param doc - The canvas document.
 * @param nodeId - Id of the node whose model to switch.
 * @param mode - The active generation sub-mode this pick belongs to.
 * @param model - The new model id.
 * @param paramsByModel - Every per-model record to persist (#1948), written whole.
 */
export function setNodeModelInDoc(
  doc: Y.Doc,
  nodeId: string,
  mode: string,
  model: string,
  paramsByModel: Record<string, Record<string, unknown>>,
): void {
  const data = nodeDataMap(doc, nodeId);
  if (!data) return;
  const fields = modelPickFields(data, mode, model, paramsByModel);
  data.set('model', model);
  // Whole, not merged (see setNodeParamsInDoc for why).
  data.set('paramsByModel', paramsByModel);
  data.set('modelByMode', fields.modelByMode);
}

/**
 * Switch a content node's generation sub-mode, with the model and param
 * records resolved for it. Does NOT touch `modelByMode`: a toggle is not an
 * explicit pick.
 * @param doc - The canvas document.
 * @param nodeId - Id of the node whose mode to switch.
 * @param mode - The new generation sub-mode.
 * @param model - The model to select for the new mode.
 * @param paramsByModel - Every per-model record to persist (#1948), written whole.
 */
export function setNodeModeInDoc(
  doc: Y.Doc,
  nodeId: string,
  mode: string,
  model: string,
  paramsByModel: Record<string, Record<string, unknown>>,
): void {
  const data = nodeDataMap(doc, nodeId);
  if (!data) return;
  data.set('mode', mode);
  data.set('model', model);
  // Whole, not merged (see setNodeParamsInDoc for why).
  data.set('paramsByModel', paramsByModel);
}

/**
 * Hand back a text node's body, seeding an empty one where a node older than
 * #1774 has none. Idempotent: a node that already has a body gets that body
 * back untouched.
 * @param doc - The canvas document.
 * @param nodeId - Id of the text node.
 * @returns The node's body, or `null` when the node itself is gone.
 */
export function ensureTextBodyInDoc(doc: Y.Doc, nodeId: string): Y.XmlFragment | null {
  const data = nodeDataMap(doc, nodeId);
  if (!data) return null;
  const existing = data.get('body');
  if (existing instanceof Y.XmlFragment) return existing;
  const body = bodyFromText('');
  data.set('body', body);
  return body;
}

/**
 * Land a finished handling's content on a node, in the field its type reads.
 *
 * A text node's words live in its shared body, never in `data.content`: the
 * node view deliberately does not carry the body (#1774), so words written to
 * the plain field would be stored, synced, and never shown — the node would
 * come back from a dropped `.txt` looking empty. Every other modality's
 * content IS a plain field (an asset URL), so the split is by type, once,
 * here. Same rule as node creation, which drops `content` for a text node and
 * seeds the body instead.
 *
 * A missing body is created rather than skipped. Losing the words of a file
 * the user just dropped is the worse failure, and the node is by definition
 * not being edited right now — this runs under a lease, and a node a task is
 * writing cannot be opened for editing. The seed here is deliberately NOT
 * routed through {@link ensureTextBodyInDoc}: that path seeds an empty body for
 * an editor to bind, while this one already holds the words and lands them in
 * a single write. Same absence check, different write; if the shape of a
 * seeded body ever changes, change both.
 * @param data - The node's data map, already verified to be one.
 * @param type - The node's modality, read from its `type` field.
 * @param content - What the handling produced: an asset URL, or extracted text.
 */
export function landHandlingContent(
  data: Y.Map<unknown>,
  type: unknown,
  content: string,
): void {
  if (type !== 'text') {
    data.set('content', content);
    return;
  }
  const body = data.get('body');
  if (body instanceof Y.XmlFragment) writePlainTextIntoBody(body, content);
  else data.set('body', bodyFromText(content));
}

/**
 * Write a node's extracted text in the field its type reads.
 * @param doc - The canvas document.
 * @param nodeId - Id of the node to fill.
 * @param content - The extracted text.
 */
export function setNodeExtractedTextInDoc(doc: Y.Doc, nodeId: string, content: string): void {
  const node = canvasNodesMap(doc).get(nodeId);
  const data = node?.get('data');
  if (!node || !(data instanceof Y.Map)) return;
  landHandlingContent(data, node.get('type'), content);
}

/**
 * Restore a past node result (#1619): its content, then the cover and media
 * numbers through `writeNodeMedia`, the function a settle writes them with
 * (#2184), each value set and each null removed.
 * @param doc - The canvas document.
 * @param nodeId - Id of the node to restore onto.
 * @param restored - What to put back on the node.
 * @param restored.content - The history row's content.
 * @param restored.media - The cover and media numbers it landed with.
 */
export function restoreNodeMediaInDoc(
  doc: Y.Doc,
  nodeId: string,
  restored: { content: string; media: NodeMediaFields },
): void {
  const node = canvasNodesMap(doc).get(nodeId);
  const data = node?.get('data');
  if (!node || !(data instanceof Y.Map)) return;
  // Which field holds a node's content is decided by its type, once, in
  // `landHandlingContent` — a text node's words live in the body the editor
  // binds to and would be invisible in the plain field (#1774).
  landHandlingContent(data, node.get('type'), restored.content);
  // The same function a settle writes these through, so a restored node
  // holds what the result held when it first landed. A row written before
  // #2184 carries none, which removes the previous result's numbers rather
  // than leaving them to describe a medium the node no longer shows.
  writeNodeMedia(data, restored.media);
}

/**
 * Set (or clear, with `undefined`) a group's background tint. No-op when the
 * group does not exist.
 * @param doc - The canvas document.
 * @param groupId - Id of the group to tint.
 * @param color - The new background token, or `undefined` to clear it.
 */
export function setGroupBackgroundInDoc(doc: Y.Doc, groupId: string, color: string | undefined): void {
  const entry = groupEntry(doc, groupId);
  if (!entry) return;
  if (color === undefined) entry.data.delete('backgroundColor');
  else entry.data.set('backgroundColor', color);
}

/**
 * Create a Group around a selection: insert the Group node (carrying its
 * authoritative width/height in `data`) and bind each member — its top-level
 * `parentId` and its new parent-relative position.
 * @param doc - The canvas document.
 * @param group - The Group node's wire fields (id, position, `data.width/height`).
 * @param members - The members to bind, each with its parent-relative position.
 */
export function createGroupInDoc(
  doc: Y.Doc,
  group: CanvasNodeFields,
  members: ReadonlyArray<{ id: string; position: { x: number; y: number } }>,
): void {
  const nodesMap = canvasNodesMap(doc);
  const map = new Y.Map<unknown>();
  map.set('id', group.id);
  map.set('type', group.type);
  if (group.parentId !== undefined) map.set('parentId', group.parentId);
  map.set('position', group.position);
  map.set('data', buildDataMap(group.data, group.type));
  nodesMap.set(group.id, map);
  for (const member of members) {
    const node = nodesMap.get(member.id);
    if (!(node instanceof Y.Map)) continue;
    node.set('parentId', group.id);
    node.set('position', member.position);
  }
}

/**
 * Whether a node can be reparented onto `parentId`: the node is there, and
 * so is the Group (a Group gone since the caller planned would leave a parent
 * nobody can see).
 * @param doc - The canvas document.
 * @param nodeId - The node.
 * @param parentId - The new parent Group id, or null for top-level.
 * @returns Whether the reparent applies.
 */
export function reparentApplies(doc: Y.Doc, nodeId: string, parentId: string | null): boolean {
  const nodesMap = canvasNodesMap(doc);
  if (!(nodesMap.get(nodeId) instanceof Y.Map)) return false;
  return parentId === null || nodesMap.get(parentId) instanceof Y.Map;
}

/**
 * Reparent a node: set (or clear, for null) its top-level `parentId` and
 * write its new position, in the coordinate space the caller supplies.
 * @param doc - The canvas document.
 * @param nodeId - Id of the node to reparent.
 * @param parentId - The new parent Group id, or null to make the node top-level.
 * @param position - The node's new position (relative when joining, absolute when leaving).
 * @param position.x - New x coordinate.
 * @param position.y - New y coordinate.
 */
export function setNodeParentInDoc(
  doc: Y.Doc,
  nodeId: string,
  parentId: string | null,
  position: { x: number; y: number },
): void {
  if (!reparentApplies(doc, nodeId, parentId)) return;
  const node = canvasNodesMap(doc).get(nodeId);
  if (!node) return;
  if (parentId === null) node.delete('parentId');
  else node.set('parentId', parentId);
  node.set('position', position);
}

/**
 * Resize a Group: its new top-left and authoritative `data.width`/`height`.
 * Where its members end up is the caller's to write.
 * @param doc - The canvas document.
 * @param groupId - Id of the Group to resize.
 * @param position - The Group's new top-left.
 * @param position.x - New x coordinate.
 * @param position.y - New y coordinate.
 * @param width - The Group's new width.
 * @param height - The Group's new height.
 * @returns Whether the Group was there to write.
 */
export function resizeGroupInDoc(
  doc: Y.Doc,
  groupId: string,
  position: { x: number; y: number },
  width: number,
  height: number,
): boolean {
  const entry = groupEntry(doc, groupId);
  if (!entry) return false;
  entry.group.set('position', position);
  entry.data.set('width', width);
  entry.data.set('height', height);
  return true;
}

/**
 * Grow a Group to a new rect AND reanchor its members so their ABSOLUTE
 * positions stay put: when the top-left moves, every member's parent-relative
 * position shifts by the inverse delta.
 * @param doc - The canvas document.
 * @param groupId - Id of the Group to grow.
 * @param position - The Group's new top-left.
 * @param position.x - New x coordinate.
 * @param position.y - New y coordinate.
 * @param width - The Group's new width.
 * @param height - The Group's new height.
 */
export function expandGroupInDoc(
  doc: Y.Doc,
  groupId: string,
  position: { x: number; y: number },
  width: number,
  height: number,
): void {
  const entry = groupEntry(doc, groupId);
  if (!entry) return;
  const { group, data } = entry;
  const oldPos = group.get('position') as { x: number; y: number } | undefined;
  const dx = oldPos ? oldPos.x - position.x : 0;
  const dy = oldPos ? oldPos.y - position.y : 0;
  group.set('position', position);
  data.set('width', width);
  data.set('height', height);
  if (dx !== 0 || dy !== 0) {
    canvasNodesMap(doc).forEach((node) => {
      if (!(node instanceof Y.Map) || node.get('parentId') !== groupId) return;
      const p = node.get('position') as { x: number; y: number } | undefined;
      if (p) node.set('position', { x: p.x + dx, y: p.y + dy });
    });
  }
}

/**
 * Write one edge inside an open transaction. Both endpoints are checked
 * against live Yjs state here — this is the airtight write boundary. A
 * caller's guard reads its React closure, which goes stale the instant a
 * collaborator deletes a node (Yjs applies the deletion before React
 * re-creates the handler), so the only race-free place to reject an orphaned
 * edge is atomically with the write.
 * @param nodesMap - The canvas-space `nodesMap`.
 * @param edgesMap - The canvas-space `edgesMap`.
 * @param edge - The edge.
 * @returns Whether the edge is in the document afterwards, so a caller can
 *   surface feedback (a silently-rejected edge must not read as success).
 */
export function putEdge(
  nodesMap: Y.Map<Y.Map<unknown>>,
  edgesMap: Y.Map<Y.Map<unknown>>,
  edge: CanvasEdge,
): boolean {
  if (edge.source === edge.target) return false;
  if (!nodesMap.has(edge.source) || !nodesMap.has(edge.target)) return false;
  // Deterministic ids make a duplicate drag map onto the EXISTING entry —
  // rewriting it would replace createdAt (the reference silently jumps to
  // the rail's end) and push a spurious undo entry. Idempotent success.
  if (edgesMap.has(edge.id)) return true;
  const map = new Y.Map<unknown>();
  map.set('id', edge.id);
  map.set('source', edge.source);
  map.set('target', edge.target);
  if (edge.toolId) map.set('toolId', edge.toolId);
  // Connection time drives reference-rail order (undo re-inserts the map
  // with its original stamp, so an undone+redone edge keeps its place).
  map.set('createdAt', edge.createdAt ?? Date.now());
  edgesMap.set(edge.id, map);
  return true;
}

/**
 * Add an edge (a connection = a reference relationship).
 * @param doc - The canvas document.
 * @param edge - The edge to insert.
 * @returns Whether the edge is in the document afterwards.
 */
export function addEdgeInDoc(doc: Y.Doc, edge: CanvasEdge): boolean {
  return putEdge(canvasNodesMap(doc), canvasEdgesMap(doc), edge);
}

/**
 * Delete an edge by id.
 * @param doc - The canvas document.
 * @param edgeId - Id of the edge to delete.
 */
export function removeEdgeInDoc(doc: Y.Doc, edgeId: string): void {
  canvasEdgesMap(doc).delete(edgeId);
}
