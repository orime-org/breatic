// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Canvas clipboard pure functions (slice 2b).
 *
 * The system clipboard is the single source of truth: copying nodes writes a
 * marker-tagged JSON payload via `navigator.clipboard.writeText`, and the
 * canvas `paste` handler reads it back — distinguishing "paste nodes" from
 * "paste plain text" by the marker. These helpers stay DOM/ReactFlow-free so
 * the serialize / parse / clone logic is unit-testable in isolation.
 */

import type { CanvasNodeFields } from '@breatic/shared';
import { newId } from '@breatic/shared';
import type { CanvasEdge, SnapshotNode } from '@web/data/yjs/canvas-space';
import { MENTION_SOURCE_ID_ATTR, REFERENCE_MENTION_NODE } from '@web/features/reference-mention/mention-node';
import { MENTION_LABEL_ATTR } from '@web/spaces/canvas/generate/reference-mention';
import { FOCUS_REF_PREFIX } from '@web/spaces/canvas/generate/derive-references';
import { regionOf, regionOwnsKeyboard } from '@web/features/active-region/keyboard-scope';

import {
  createEmptyNode,
  isCreatableNodeType,
  type CreatableNodeType,
} from '@web/spaces/canvas/node-factory';
import { MODALITY_LABEL } from '@web/spaces/canvas/nodes/_shared/modality';
import {
  EMPTY_NODE_SIZE,
  toAbsolutePosition,
} from '@web/spaces/canvas/group-geometry';

/**
 * Prefix prepended to a clone's display name so a copy is visually distinct from
 * its source (R2-C). Applied to ROOT clones only — a top-level node, a cloned
 * Group, or a lone member rejoining an existing Group — never to a member that
 * follows its cloned Group (those keep their name).
 */
const COPY_PREFIX = 'COPY-';

/**
 * Marker prefix tagging clipboard text as serialized breatic canvas nodes.
 * Plain pasted text never starts with this, so the paste handler can branch
 * on it without ambiguity.
 */
export const CLIPBOARD_MARKER = '__breatic_canvas_nodes__:';

/** The clipboard format this build writes and reads; anything else is plain text. */
export const CLIPBOARD_VERSION = 2;

/** A clipboard entry's type — a content node, a Group, or a sticky (Agent box only). */
export type ClipboardNodeType = CreatableNodeType | 'group' | 'annotation';

/** Where a copy was made. */
export interface ClipboardSource {
  projectId: string;
  spaceId: string;
}

/**
 * One node on the clipboard: where it sat and everything it stored (inner#1349).
 * Positions are ABSOLUTE (a member is resolved at capture) so the paste shift
 * applies uniformly; the clone turns a member back into a group-relative one.
 */
export interface ClipboardNode {
  /** Source node id — links members to their Group and edges to their ends. */
  id: string;
  type: ClipboardNodeType;
  /** Absolute canvas position. */
  position: { x: number; y: number };
  /** Source parent Group id (members only). */
  parentId?: string;
  /** Rendered (content) or stored (Group) width, for centring a paste. */
  width?: number;
  /** Rendered (content) or stored (Group) height. */
  height?: number;
  /** The node's whole stored data, as `snapshotNodeData` writes it. */
  data: Record<string, unknown>;
  /**
   * `data.content` is an address outside our storage. A paste never pins it on
   * the node: it creates an empty node and has the server fetch the address
   * into storage, which then writes the stored address onto the node.
   */
  external?: boolean;
}

/** An edge on the clipboard. */
export interface ClipboardEdge {
  id: string;
  source: string;
  target: string;
  toolId?: string;
  createdAt?: number;
}

/** What Copy writes and Paste reads. */
export interface ClipboardPayload {
  version: typeof CLIPBOARD_VERSION;
  /** Where it was copied; absent for a picture copied in the chat column. */
  source?: ClipboardSource;
  /** The ids the reader actually selected; the Agent card is named from them. */
  picked: string[];
  nodes: ClipboardNode[];
  /** Edges between copied nodes, and from an uncopied node into a copied one. */
  edges: ClipboardEdge[];
}

/** The minimal shape {@link captureClipboard} / {@link externalParentAbs} read off a canvas node. */
export interface CaptureNode {
  id: string;
  type?: string;
  parentId?: string;
  position: { x: number; y: number };
  /** Rendered size (content nodes) — recorded so a paste can centre the payload. */
  measured?: { width?: number; height?: number };
  data?: { locked?: unknown };
}

/**
 * Capture the given nodes onto the clipboard — Group-aware: a selected Group
 * brings every member (resolved to absolute coordinates, linked back by
 * `parentId`); a lone member keeps `parentId` so a duplicate can rejoin its
 * Group; members are emitted once. Each node carries its whole stored data;
 * stickies are captured for the Agent box and skipped by the canvas clone.
 * @param targetIds - The ids the reader selected or right-clicked.
 * @param allNodes - All canvas nodes (to resolve members and absolute positions).
 * @param dataOf - Reads a node's stored data snapshot.
 * @param allEdges - All canvas edges.
 * @param source - Where the copy is made.
 * @returns The payload (Groups first, then their members, then loose nodes).
 */
export function captureClipboard(
  targetIds: ReadonlyArray<string>,
  allNodes: ReadonlyArray<CaptureNode>,
  dataOf: (id: string) => Record<string, unknown>,
  allEdges: ReadonlyArray<ClipboardEdge>,
  source: ClipboardSource,
): ClipboardPayload {
  const byId = new Map(allNodes.map((node) => [node.id, node]));
  /**
   * The node's absolute position.
   * @param node - The node.
   * @returns Its absolute position.
   */
  const absPos = (node: CaptureNode): { x: number; y: number } => {
    const parent = node.parentId !== undefined ? byId.get(node.parentId) : undefined;
    return parent
      ? toAbsolutePosition(node.position, parent.position)
      : { x: node.position.x, y: node.position.y };
  };
  const emitted = new Set<string>();
  const nodes: ClipboardNode[] = [];
  /**
   * Emit a content node or sticky once.
   * @param node - The node.
   */
  const emitContent = (node: CaptureNode): void => {
    if (node.type === undefined || emitted.has(node.id)) return;
    if (!isCreatableNodeType(node.type) && node.type !== 'annotation') return;
    emitted.add(node.id);
    nodes.push({
      id: node.id,
      type: node.type,
      position: absPos(node),
      ...(node.parentId !== undefined ? { parentId: node.parentId } : {}),
      ...(typeof node.measured?.width === 'number' ? { width: node.measured.width } : {}),
      ...(typeof node.measured?.height === 'number' ? { height: node.measured.height } : {}),
      data: dataOf(node.id),
    });
  };
  const targets = targetIds
    .map((id) => byId.get(id))
    .filter((node): node is CaptureNode => node !== undefined);
  for (const node of targets) {
    if (node.type !== 'group' || emitted.has(node.id)) continue;
    emitted.add(node.id);
    const data = dataOf(node.id);
    nodes.push({
      id: node.id,
      type: 'group',
      position: { x: node.position.x, y: node.position.y },
      ...(typeof data.width === 'number' ? { width: data.width } : {}),
      ...(typeof data.height === 'number' ? { height: data.height } : {}),
      data,
    });
    for (const member of allNodes) {
      if (member.parentId === node.id) emitContent(member);
    }
  }
  for (const node of targets) {
    if (node.type !== 'group') emitContent(node);
  }
  return {
    version: CLIPBOARD_VERSION,
    source,
    picked: targets.map((node) => node.id),
    nodes,
    edges: allEdges.filter((edge) => emitted.has(edge.target)).map((edge) => ({ ...edge })),
  };
}

/**
 * Resolve the absolute position of every EXISTING Group a payload member points
 * at but that is NOT itself in the payload — i.e. a member captured alone.
 * {@link cloneForPaste} rejoins such a clone to that Group; a locked Group has
 * frozen membership and is left out, so the clone becomes top-level (Bug A).
 * @param payload - The payload's nodes.
 * @param allNodes - All canvas nodes (to look up the existing Group's position).
 * @returns Map of existing-Group id → absolute top-left.
 */
export function externalParentAbs(
  payload: ReadonlyArray<ClipboardNode>,
  allNodes: ReadonlyArray<CaptureNode>,
): Map<string, { x: number; y: number }> {
  const groupsInPayload = new Set(payload.filter((node) => node.type === 'group').map((node) => node.id));
  const byId = new Map(allNodes.map((node) => [node.id, node]));
  const map = new Map<string, { x: number; y: number }>();
  for (const node of payload) {
    if (node.parentId === undefined || groupsInPayload.has(node.parentId)) continue;
    const parent = byId.get(node.parentId);
    if (parent === undefined || parent.data?.locked) continue;
    map.set(node.parentId, { x: parent.position.x, y: parent.position.y });
  }
  return map;
}

/**
 * Serialize a payload for the system clipboard.
 * @param payload - The payload.
 * @returns `CLIPBOARD_MARKER` followed by its JSON.
 */
export function serializeClipboard(payload: ClipboardPayload): string {
  return CLIPBOARD_MARKER + JSON.stringify(payload);
}

/**
 * Parse clipboard text back into a payload — only our marked, current-version
 * payload; anything else is pasted as plain text.
 * @param text - Raw clipboard text.
 * @returns The payload, or `null`.
 */
export function parseClipboard(text: string): ClipboardPayload | null {
  if (!text.startsWith(CLIPBOARD_MARKER)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(CLIPBOARD_MARKER.length));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const candidate = parsed as Partial<ClipboardPayload>;
  if (candidate.version !== CLIPBOARD_VERSION) return null;
  if (!Array.isArray(candidate.nodes) || !Array.isArray(candidate.edges)) return null;
  return {
    ...(candidate as ClipboardPayload),
    picked: Array.isArray(candidate.picked) ? candidate.picked : [],
  };
}

/**
 * Whether a paste belongs to the canvas.
 *
 * The canvas takes a paste while the space holds the keyboard. Its own nodes
 * it also takes after a click in another region: copying a picture in the
 * agent column leaves the keyboard there, and canvas nodes have nowhere else
 * to go. A paste inside an open overlay stays the overlay's.
 * @param target - The paste event's target.
 * @param text - The clipboard's plain text.
 * @returns Whether the canvas handles this paste.
 */
export function canvasTakesPaste(target: EventTarget | null, text: string): boolean {
  if (regionOwnsKeyboard(target, 'space')) return true;
  if (!text.startsWith(CLIPBOARD_MARKER) || !(target instanceof Element)) return false;
  return target === document.body || regionOf(target) !== null;
}

/** Fields that are a node's state or its running work, not its content (2026-10-09). */
const NOT_COPIED = ['locked', 'taskCounts', 'errorMessage'] as const;

/** What {@link cloneForPaste} produces. */
export interface PastedClones {
  /** The clones, Groups before their members, ready for `writeSnapshotNodes`. */
  nodes: SnapshotNode[];
  /** The edges to write with them. */
  edges: CanvasEdge[];
  /** Source id → clone id. */
  idMap: Map<string, string>;
}

/** Options for {@link cloneForPaste}. */
export interface CloneOptions {
  /** Absolute positions of existing Groups a lone member may rejoin. */
  externalParentAbs?: ReadonlyMap<string, { x: number; y: number }>;
  /**
   * Whether an uncopied upstream node keeps its edge into a copy — true only on
   * the Space the copy was made on, for a node still there (design 5.5).
   */
  keepUpstream?: (sourceId: string) => boolean;
}

/**
 * Clone a payload into fresh nodes and edges for the canvas (design 5.2–5.6).
 * Content is carried whole; a node's state and running work are not (lock,
 * task counts, failure message), and its creation stamp is new. Members of a
 * copied Group follow the fresh Group; a lone member rejoins an existing Group
 * when one is given, else becomes top-level. Stickies are not pasted onto the
 * canvas. Edges between copies are rebuilt, and an upstream edge is kept when
 * `keepUpstream` says so; their `createdAt` keeps the original order. Mentions
 * of copied nodes point at the copies, kept upstream and focus mentions stay,
 * any other mention becomes the text "@name".
 * @param payload - The clipboard payload.
 * @param createdBy - User id minted onto every clone.
 * @param offset - Per-axis shift applied to each absolute position.
 * @param offset.dx - X shift.
 * @param offset.dy - Y shift.
 * @param options - Existing Groups and the upstream rule.
 * @returns The clones, their edges and the id map.
 */
export function cloneForPaste(
  payload: ClipboardPayload,
  createdBy: string,
  offset: { dx: number; dy: number },
  options: CloneOptions = {},
): PastedClones {
  const keepUpstream = options.keepUpstream ?? ((): boolean => false);
  const nodes = payload.nodes.filter(
    (node): node is ClipboardNode & { type: CreatableNodeType | 'group' } => node.type !== 'annotation',
  );
  const idMap = new Map<string, string>();
  const groupAbsById = new Map<string, { x: number; y: number }>();
  for (const node of nodes) {
    idMap.set(node.id, newId());
    if (node.type === 'group') {
      groupAbsById.set(node.id, { x: node.position.x + offset.dx, y: node.position.y + offset.dy });
    }
  }
  const edges = cloneEdges(payload.edges, idMap, keepUpstream);
  const keptUpstream = new Set(
    payload.edges
      .filter((edge) => !idMap.has(edge.source) && idMap.has(edge.target) && keepUpstream(edge.source))
      .map((edge) => edge.source),
  );
  const now = Date.now();
  const clones = nodes.map((node): SnapshotNode => {
    const freshId = idMap.get(node.id) as string;
    const absShifted = { x: node.position.x + offset.dx, y: node.position.y + offset.dy };
    let parentId: string | undefined;
    let position = absShifted;
    const following = node.parentId !== undefined && groupAbsById.has(node.parentId);
    if (following) {
      parentId = idMap.get(node.parentId as string);
      const parentAbs = groupAbsById.get(node.parentId as string) as { x: number; y: number };
      position = { x: absShifted.x - parentAbs.x, y: absShifted.y - parentAbs.y };
    } else if (node.parentId !== undefined && options.externalParentAbs?.has(node.parentId)) {
      parentId = node.parentId;
      const parentAbs = options.externalParentAbs.get(node.parentId) as { x: number; y: number };
      position = { x: absShifted.x - parentAbs.x, y: absShifted.y - parentAbs.y };
    }
    const data = rewriteMentions(contentOf(node.data), idMap, keptUpstream) as Record<string, unknown>;
    const fallbackName = node.type === 'group' ? 'Group' : MODALITY_LABEL[node.type];
    const name = typeof data.name === 'string' ? data.name : fallbackName;
    if (node.external === true) {
      // Not a copy of a node, so no COPY- prefix; and not our address, so the
      // node stays empty until the fetch into storage writes one.
      delete data.content;
    }
    return {
      id: freshId,
      type: node.type,
      position,
      ...(parentId !== undefined ? { parentId } : {}),
      data: {
        attachments: [],
        ...data,
        name: following || node.external === true ? name : COPY_PREFIX + name,
        createdAt: now,
        createdBy,
        locked: false,
      },
    };
  });
  return { nodes: clones, edges, idMap };
}

/**
 * A node's data without its state and running work.
 * @param data - The stored data snapshot.
 * @returns A copy without the fields in {@link NOT_COPIED}.
 */
function contentOf(data: Record<string, unknown>): Record<string, unknown> {
  const out = { ...data };
  for (const key of NOT_COPIED) delete out[key];
  return out;
}

/**
 * Rebuild the edges for a paste, keeping the reference order: each target's
 * incoming edges are ordered by (createdAt, id) as on the source, then stamped
 * with strictly increasing `createdAt`, because the copies' edge ids differ and
 * would otherwise break ties differently (design 5.5).
 * @param edges - The payload's edges.
 * @param idMap - Source id → clone id.
 * @param keepUpstream - Whether an uncopied upstream node keeps its edge.
 * @returns The edges to write.
 */
function cloneEdges(
  edges: ReadonlyArray<ClipboardEdge>,
  idMap: ReadonlyMap<string, string>,
  keepUpstream: (sourceId: string) => boolean,
): CanvasEdge[] {
  const ordered = [...edges].sort(
    (a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  const out: CanvasEdge[] = [];
  let last = -Infinity;
  for (const edge of ordered) {
    const target = idMap.get(edge.target);
    if (target === undefined) continue;
    const copiedSource = idMap.get(edge.source);
    const source = copiedSource ?? (keepUpstream(edge.source) ? edge.source : undefined);
    if (source === undefined) continue;
    const createdAt = Math.max(edge.createdAt ?? 0, last + 1);
    last = createdAt;
    out.push({
      id: `${source}->${target}`,
      source,
      target,
      ...(edge.toolId !== undefined ? { toolId: edge.toolId } : {}),
      createdAt,
    });
  }
  return out;
}

/**
 * Rewrite every reference mention in a snapshot value (design 5.6): a mention
 * of a copied node points at its copy; a focus mention and a mention of a kept
 * upstream node stay; any other becomes the text "@name".
 * @param value - A snapshot value (plain or tagged).
 * @param idMap - Source id → clone id.
 * @param keptUpstream - Upstream ids whose edges were kept.
 * @returns The rewritten value.
 */
function rewriteMentions(
  value: unknown,
  idMap: ReadonlyMap<string, string>,
  keptUpstream: ReadonlySet<string>,
): unknown {
  if (Array.isArray(value)) return value.map((item) => rewriteMentions(item, idMap, keptUpstream));
  if (typeof value !== 'object' || value === null) return value;
  const record = value as Record<string, unknown>;
  if (record.el === REFERENCE_MENTION_NODE && typeof record.attrs === 'object' && record.attrs !== null) {
    const attrs = record.attrs as Record<string, unknown>;
    const sourceId = attrs[MENTION_SOURCE_ID_ATTR];
    if (typeof sourceId === 'string') {
      if (sourceId.startsWith(FOCUS_REF_PREFIX) || keptUpstream.has(sourceId)) return record;
      const copy = idMap.get(sourceId);
      if (copy !== undefined) return { ...record, attrs: { ...attrs, [MENTION_SOURCE_ID_ATTR]: copy } };
    }
    const label = typeof attrs[MENTION_LABEL_ATTR] === 'string' ? (attrs[MENTION_LABEL_ATTR] as string) : '';
    return { text: [{ insert: `@${label}` }] };
  }
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(record)) out[key] = rewriteMentions(entry, idMap, keptUpstream);
  return out;
}

/**
 * The bounding box of a clipboard payload (positions + sizes) — the rect a
 * viewport-center paste centres on. A node carrying no recorded size falls
 * back to the empty-node footprint.
 * @param nodes - The payload's nodes.
 * @returns The union rect in flow coordinates (empty → a zero rect at the origin).
 */
export function clipboardBoundingBox(
  nodes: ReadonlyArray<Pick<ClipboardNode, 'position' | 'width' | 'height'>>,
): { x: number; y: number; width: number; height: number } {
  if (nodes.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const node of nodes) {
    const w = node.width ?? EMPTY_NODE_SIZE.width;
    const h = node.height ?? EMPTY_NODE_SIZE.height;
    minX = Math.min(minX, node.position.x);
    minY = Math.min(minY, node.position.y);
    maxX = Math.max(maxX, node.position.x + w);
    maxY = Math.max(maxY, node.position.y + h);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/**
 * Pixels a copy moves: a paste beside its in-view source and past a taken
 * spot, and a Cmd/Ctrl+D duplicate down-right of its source.
 */
export const PASTE_OFFSET_PX = 24;

/**
 * How far a paste moves the payload, relative to where it was copied from.
 *
 * Nodes copied on this Space land beside their source (+{@link PASTE_OFFSET_PX})
 * while any part of it is in view. Anything else — a source scrolled fully out
 * of view, nodes copied on another Space, pictures from outside — has its
 * bounding box centred on the view, so the paste is never dropped off-screen
 * (R2-H, inner#1235 A20). Stepping past nodes already on that spot is the
 * paste's own job (see {@link stepPastOccupied}).
 * @param payload - The clipboard payload.
 * @param viewport - The visible canvas rect, in flow coordinates.
 * @param viewport.x - Its left edge.
 * @param viewport.y - Its top edge.
 * @param viewport.width - Its width.
 * @param viewport.height - Its height.
 * @param space - The Space pasted into.
 * @returns The shift to apply to every node's position.
 */
export function pasteOffsetFor(
  payload: ClipboardPayload,
  viewport: { x: number; y: number; width: number; height: number },
  space: string,
): { dx: number; dy: number } {
  const beside = { dx: PASTE_OFFSET_PX, dy: PASTE_OFFSET_PX };
  // A degenerate viewport (zero area — no layout measured yet) can't drive a
  // meaningful recenter, so fall back to the in-place nudge.
  if (viewport.width <= 0 || viewport.height <= 0) return beside;
  const box = clipboardBoundingBox(payload.nodes);
  // In view = the payload's bounding box overlaps the CURRENT viewport at all.
  const intersects =
    box.x < viewport.x + viewport.width &&
    box.x + box.width > viewport.x &&
    box.y < viewport.y + viewport.height &&
    box.y + box.height > viewport.y;
  if (intersects && payload.source?.spaceId === space) return beside;
  return {
    dx: viewport.x + viewport.width / 2 - (box.x + box.width / 2),
    dy: viewport.y + viewport.height / 2 - (box.y + box.height / 2),
  };
}

/**
 * How far a paste steps down and right so none of what it makes lands on top
 * of a node already there: a node whose top-left is less than
 * {@link PASTE_OFFSET_PX} away from a pasted node's top-left on both axes is on
 * its spot, and the whole batch moves one such step at a time until no pasted
 * node has one. Every paste goes through it — nodes, text, files — so a copy
 * always shows (inner#1235 A20).
 * @param corners - Where each pasted node's top-left would land, in flow
 *   coordinates.
 * @param occupied - Top-left corners of the nodes already on the Space.
 * @returns The extra shift for the whole batch.
 */
export function stepPastOccupied(
  corners: ReadonlyArray<{ x: number; y: number }>,
  occupied: ReadonlyArray<{ x: number; y: number }>,
): { dx: number; dy: number } {
  const step = PASTE_OFFSET_PX;
  let shift = 0;
  /**
   * Whether any pasted node, shifted, sits within a step of a node already there.
   * @returns True while the batch's spot is taken.
   */
  const taken = (): boolean =>
    corners.some((corner) =>
      occupied.some(
        (at) =>
          Math.abs(at.x - (corner.x + shift)) < step && Math.abs(at.y - (corner.y + shift)) < step,
      ),
    );
  while (taken()) shift += step;
  return { dx: shift, dy: shift };
}

/**
 * Build a fresh text node carrying pasted plain text, with empty-node defaults
 * otherwise. Reuses {@link createEmptyNode} so the wire shape stays in one place.
 * @param text - The pasted plain text, stored as the node's content.
 * @param position - Canvas position to place the node at.
 * @param position.x - X coordinate.
 * @param position.y - Y coordinate.
 * @param createdBy - User id of the creator (caller injects from store).
 * @returns A complete `CanvasNodeFields` text node.
 */
export function textToNode(
  text: string,
  position: { x: number; y: number },
  createdBy: string,
): CanvasNodeFields {
  const node = createEmptyNode('text', position, createdBy);
  return { ...node, data: { ...node.data, content: text } };
}
