// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

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

import {
  createEmptyNode,
  createGroupNode,
  EMPTY_NODE_SIZE,
  isCreatableNodeType,
  type CreatableNodeType,
} from '@web/spaces/canvas/node-factory';

/** Fallback Group size when a captured Group entry is missing its stored size. */
const GROUP_CLONE_FALLBACK = 192;

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

/** A clipboard entry's modality — a creatable content node, or a Group. */
export type ClipboardNodeType = CreatableNodeType | 'group';

/**
 * The portable subset of a node carried through the system clipboard — only
 * what's needed to re-create it elsewhere (ids / metadata are minted fresh on
 * clone). Positions are ABSOLUTE (a member is resolved to absolute at capture)
 * so the paste-anchor shift applies uniformly to Groups, members, and top-level
 * nodes; the clone converts a child back to a parent-relative position. A Group
 * carries its size; a member carries `parentId` so it re-homes to the cloned
 * Group (when the Group is in the payload) or rejoins the existing Group (when
 * it is not — see {@link externalParentAbs}). Annotations are not copyable.
 */
export interface ClipboardNode {
  /** Content modality (text / image / audio / video) or `group`. */
  type: ClipboardNodeType;
  /** Absolute canvas position (offset is applied on clone). */
  position: { x: number; y: number };
  /** Display name, when the source node had one. */
  name?: string;
  /** Content payload (text body / asset url), when present. */
  content?: string;
  /** Group authoritative width (Group entries only). */
  width?: number;
  /** Group authoritative height (Group entries only). */
  height?: number;
  /** Group background token (Group entries only). */
  backgroundColor?: string;
  /** Source node id — links a captured member to its captured Group within the payload. */
  id?: string;
  /** Source parent Group id (members only). */
  parentId?: string;
}

/** The minimal shape {@link captureClipboard} / {@link externalParentAbs} read off a canvas node. */
export interface CaptureNode {
  id: string;
  type?: string;
  parentId?: string;
  position: { x: number; y: number };
  /** Rendered size (content nodes) — recorded so a paste can centre the payload. */
  measured?: { width?: number; height?: number };
  data?: {
    name?: unknown;
    content?: unknown;
    width?: unknown;
    height?: unknown;
    backgroundColor?: unknown;
  };
}

/**
 * Capture the given target nodes into the clipboard-portable form — Group-aware:
 * a selected Group emits a Group entry PLUS every one of its members (resolved to
 * absolute coordinates, linked back by `parentId`); a lone member emits with its
 * `parentId` kept so a duplicate can rejoin the existing Group; a top-level node
 * emits with no parent. Members are de-duplicated (selecting a Group and one of
 * its members must not emit the member twice). Non-copyable nodes (annotation)
 * are skipped. DOM/ReactFlow-free so the capture logic is unit-tested in isolation.
 * @param targetIds - The ids of the nodes the user selected / right-clicked to copy.
 * @param allNodes - All canvas nodes (to resolve members + absolute coordinates).
 * @returns The clipboard payload (Groups first, then their members, then loose nodes).
 */
export function captureClipboard(
  targetIds: ReadonlyArray<string>,
  allNodes: ReadonlyArray<CaptureNode>,
): ClipboardNode[] {
  const byId = new Map(allNodes.map((node) => [node.id, node]));
  /**
   * The node's absolute position (a member's stored position is relative to its
   * Group top-left; Groups and top-level nodes are already absolute).
   * @param node - The node to resolve.
   * @returns The absolute position.
   */
  const absPos = (node: CaptureNode): { x: number; y: number } => {
    const parent = node.parentId !== undefined ? byId.get(node.parentId) : undefined;
    return parent
      ? { x: parent.position.x + node.position.x, y: parent.position.y + node.position.y }
      : { x: node.position.x, y: node.position.y };
  };
  const emitted = new Set<string>();
  const result: ClipboardNode[] = [];
  /**
   * Emit a content node (skips non-creatable types + already-emitted nodes).
   * @param node - The content node to emit.
   */
  const emitContent = (node: CaptureNode): void => {
    if (node.type === undefined || !isCreatableNodeType(node.type)) return;
    if (emitted.has(node.id)) return;
    emitted.add(node.id);
    const data = node.data ?? {};
    result.push({
      type: node.type,
      position: absPos(node),
      ...(typeof data.name === 'string' ? { name: data.name } : {}),
      ...(typeof data.content === 'string' ? { content: data.content } : {}),
      // Record the rendered size so a viewport-center paste can centre the
      // payload's bounding box (R2-H); absent until ReactFlow measures the node.
      ...(typeof node.measured?.width === 'number' ? { width: node.measured.width } : {}),
      ...(typeof node.measured?.height === 'number' ? { height: node.measured.height } : {}),
      id: node.id,
      ...(node.parentId !== undefined ? { parentId: node.parentId } : {}),
    });
  };
  const targets = targetIds
    .map((id) => byId.get(id))
    .filter((node): node is CaptureNode => node !== undefined);
  // Groups first, so each Group's members are emitted as its children and a
  // separately-selected member is de-duplicated (already in `emitted`).
  for (const node of targets) {
    if (node.type !== 'group' || emitted.has(node.id)) continue;
    emitted.add(node.id);
    const data = node.data ?? {};
    result.push({
      type: 'group',
      position: { x: node.position.x, y: node.position.y },
      ...(typeof data.name === 'string' ? { name: data.name } : {}),
      ...(typeof data.width === 'number' ? { width: data.width } : {}),
      ...(typeof data.height === 'number' ? { height: data.height } : {}),
      ...(typeof data.backgroundColor === 'string'
        ? { backgroundColor: data.backgroundColor }
        : {}),
      id: node.id,
    });
    for (const member of allNodes) {
      if (member.parentId === node.id) emitContent(member);
    }
  }
  // Remaining content targets (top-level nodes + lone members).
  for (const node of targets) {
    if (node.type === 'group') continue;
    emitContent(node);
  }
  return result;
}

/**
 * Resolve the absolute position of every EXISTING Group a payload member points
 * at but that is NOT itself in the payload — i.e. a member captured alone (its
 * Group was not selected). {@link cloneForPaste} uses this map to rejoin such a
 * clone to the existing Group (the duplicate-a-lone-member case); when omitted
 * (e.g. system-clipboard paste, which re-anchors at the cursor) the clone
 * becomes top-level instead.
 * @param payload - The captured clipboard payload.
 * @param allNodes - All canvas nodes (to look up the existing Group's position).
 * @returns Map of existing-Group id → absolute top-left, for parents outside the payload.
 */
export function externalParentAbs(
  payload: ReadonlyArray<ClipboardNode>,
  allNodes: ReadonlyArray<CaptureNode>,
): Map<string, { x: number; y: number }> {
  const groupsInPayload = new Set(
    payload
      .filter((node) => node.type === 'group' && node.id !== undefined)
      .map((node) => node.id as string),
  );
  const byId = new Map(allNodes.map((node) => [node.id, node]));
  const map = new Map<string, { x: number; y: number }>();
  for (const node of payload) {
    if (node.parentId === undefined || groupsInPayload.has(node.parentId)) continue;
    const parent = byId.get(node.parentId);
    if (parent) map.set(node.parentId, { x: parent.position.x, y: parent.position.y });
  }
  return map;
}

/**
 * Serialize selected nodes to a marker-tagged JSON string for the system
 * clipboard.
 * @param nodes - The clipboard-portable node subsets to serialize.
 * @returns `CLIPBOARD_MARKER` followed by the JSON-encoded node array.
 */
export function serializeNodes(nodes: ReadonlyArray<ClipboardNode>): string {
  return CLIPBOARD_MARKER + JSON.stringify(nodes);
}

/**
 * Parse clipboard text back into clipboard nodes — only when it's our marked,
 * well-formed node payload.
 * @param text - Raw clipboard text.
 * @returns The parsed node array, or `null` when the text is plain (no marker)
 *   or malformed (non-JSON / non-array after the marker).
 */
export function parseClipboardNodes(text: string): ClipboardNode[] | null {
  if (!text.startsWith(CLIPBOARD_MARKER)) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(CLIPBOARD_MARKER.length));
  } catch {
    return null;
  }

  if (!Array.isArray(parsed)) return null;
  return parsed as ClipboardNode[];
}

/**
 * Clone clipboard nodes into fresh wire nodes — Group-aware: new unique ids,
 * positions shifted by `offset` (so relative layout is preserved), carried name
 * / content / size, and fresh metadata (createdBy / createdAt / idle state). A
 * Group entry clones as a fresh Group; its members (whose `parentId` is the
 * Group in the payload) re-home to the FRESH Group id with their relative
 * position preserved (the uniform offset cancels in relative terms, so the
 * Group moves and members follow). A member whose `parentId` is an EXISTING
 * Group outside the payload rejoins it when `externalParentAbs` supplies that
 * Group's absolute position (duplicate-a-lone-member); otherwise it becomes
 * top-level (paste re-anchors at the cursor). Reuses {@link createEmptyNode} /
 * {@link createGroupNode} so the wire shape stays in one place.
 * @param nodes - The clipboard nodes to clone.
 * @param createdBy - User id minted onto every clone (caller injects from store).
 * @param offset - Per-axis shift applied to each node's absolute position.
 * @param offset.dx - X shift.
 * @param offset.dy - Y shift.
 * @param externalParentAbs - Absolute positions of existing Groups (outside the payload) a lone member may rejoin.
 * @returns Fresh {@link CanvasNodeFields} ready to hand to `addNode` (Groups precede their members).
 */
export function cloneForPaste(
  nodes: ReadonlyArray<ClipboardNode>,
  createdBy: string,
  offset: { dx: number; dy: number },
  externalParentAbs?: ReadonlyMap<string, { x: number; y: number }>,
): CanvasNodeFields[] {
  // Pre-mint a fresh id per entry so a member can remap its parentId to the
  // freshly-cloned Group; entries without a source id (legacy / hand-built
  // payloads) get a standalone fresh id.
  const freshIdById = new Map<string, string>();
  const groupAbsById = new Map<string, { x: number; y: number }>();
  for (const node of nodes) {
    if (node.id !== undefined) freshIdById.set(node.id, newId());
    if (node.type === 'group' && node.id !== undefined) {
      groupAbsById.set(node.id, {
        x: node.position.x + offset.dx,
        y: node.position.y + offset.dy,
      });
    }
  }
  return nodes.map((node) => {
    const freshId =
      node.id !== undefined ? (freshIdById.get(node.id) as string) : newId();
    const absShifted = {
      x: node.position.x + offset.dx,
      y: node.position.y + offset.dy,
    };
    // Resolve the parent + final (parent-relative or absolute) position.
    let parentId: string | undefined;
    let position = absShifted;
    if (node.parentId !== undefined && groupAbsById.has(node.parentId)) {
      // Parent Group is cloned in THIS payload → child of the fresh Group.
      parentId = freshIdById.get(node.parentId);
      const parentAbs = groupAbsById.get(node.parentId) as { x: number; y: number };
      position = { x: absShifted.x - parentAbs.x, y: absShifted.y - parentAbs.y };
    } else if (node.parentId !== undefined && externalParentAbs?.has(node.parentId)) {
      // Parent is an EXISTING Group outside the payload → rejoin it (duplicate a lone member).
      parentId = node.parentId;
      const parentAbs = externalParentAbs.get(node.parentId) as { x: number; y: number };
      position = { x: absShifted.x - parentAbs.x, y: absShifted.y - parentAbs.y };
    }
    if (node.type === 'group') {
      // Groups are always top-level (no parentId) → a root, so its name is
      // COPY- prefixed (R2-C). Carry the source name (R2-B), size + background.
      const group = createGroupNode(
        freshId,
        position,
        node.width ?? GROUP_CLONE_FALLBACK,
        node.height ?? GROUP_CLONE_FALLBACK,
        createdBy,
      );
      return {
        ...group,
        data: {
          ...group.data,
          name: COPY_PREFIX + (node.name ?? group.data.name),
          ...(node.backgroundColor !== undefined
            ? { backgroundColor: node.backgroundColor }
            : {}),
        },
      };
    }
    const fresh = createEmptyNode(node.type, position, createdBy);
    const baseName = node.name ?? fresh.data.name;
    // A "following member" (its Group is cloned in this payload) keeps its name;
    // every other clone is a root → COPY- prefixed (R2-C).
    const isFollowingMember =
      node.parentId !== undefined && groupAbsById.has(node.parentId);
    return {
      ...fresh,
      id: freshId,
      ...(parentId !== undefined ? { parentId } : {}),
      data: {
        ...fresh.data,
        name: isFollowingMember ? baseName : COPY_PREFIX + baseName,
        ...(node.content !== undefined ? { content: node.content } : {}),
      },
    };
  });
}

/**
 * The bounding box of a clipboard payload (positions + sizes) — the rect a
 * viewport-center paste centres on. A node carrying no recorded size (not
 * measured yet) falls back to the empty-node footprint so it still contributes a
 * sensible extent.
 * @param nodes - The clipboard payload.
 * @returns The union rect in flow coordinates (empty payload → a zero rect at the origin).
 */
export function clipboardBoundingBox(
  nodes: ReadonlyArray<ClipboardNode>,
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
 * The offset a keyboard Cmd/Ctrl+V paste should apply so the pasted nodes land
 * where the user can see them — viewport-aware, matching Figma (R2-H). When the
 * payload's bounding box sits inside the current viewport (or an area 50% larger
 * than it, Figma's rule), paste just beside it (`+offsetPx`, the in-place feel).
 * When the canvas has been scrolled so the box is well off-screen, recenter so
 * the box's CENTER lands at the viewport center (not its top-left), so the
 * content appears centred rather than offset to the bottom-right.
 * @param box - The payload's bounding box (top-left + size); a bare point is `{x,y}` with zero size.
 * @param box.x - The box left.
 * @param box.y - The box top.
 * @param box.width - The box width (0 for a bare point).
 * @param box.height - The box height (0 for a bare point).
 * @param viewport - The current viewport rect in flow coordinates.
 * @param viewport.x - The viewport left.
 * @param viewport.y - The viewport top.
 * @param viewport.width - The viewport width.
 * @param viewport.height - The viewport height.
 * @param offsetPx - The in-place nudge applied when the box is in view.
 * @returns The per-axis offset to apply to every pasted node.
 */
export function pasteAnchorOffset(
  box: { x: number; y: number; width?: number; height?: number },
  viewport: { x: number; y: number; width: number; height: number },
  offsetPx: number,
): { dx: number; dy: number } {
  // A degenerate viewport (zero area — no layout measured yet) can't drive a
  // meaningful recenter, so fall back to the in-place nudge.
  if (viewport.width <= 0 || viewport.height <= 0) {
    return { dx: offsetPx, dy: offsetPx };
  }
  // Figma considers an area 50% larger than the view to decide whether to
  // recenter — inflate the viewport by 25% on every side for the in-view test
  // (tested against the box's top-left, i.e. where the source sat).
  const marginX = viewport.width * 0.25;
  const marginY = viewport.height * 0.25;
  const inView =
    box.x >= viewport.x - marginX &&
    box.x <= viewport.x + viewport.width + marginX &&
    box.y >= viewport.y - marginY &&
    box.y <= viewport.y + viewport.height + marginY;
  if (inView) return { dx: offsetPx, dy: offsetPx };
  const boxCenterX = box.x + (box.width ?? 0) / 2;
  const boxCenterY = box.y + (box.height ?? 0) / 2;
  const viewCenterX = viewport.x + viewport.width / 2;
  const viewCenterY = viewport.y + viewport.height / 2;
  return { dx: viewCenterX - boxCenterX, dy: viewCenterY - boxCenterY };
}

/**
 * Build a fresh text node carrying pasted plain text, with empty-node defaults
 * otherwise. Reuses {@link createEmptyNode} so the wire shape stays in one place.
 * @param text - The pasted plain text, stored as the node's content.
 * @param position - Canvas position to place the node at.
 * @param position.x - X coordinate.
 * @param position.y - Y coordinate.
 * @param createdBy - User id of the creator (caller injects from store).
 * @returns A complete {@link CanvasNodeFields} text node.
 */
export function textToNode(
  text: string,
  position: { x: number; y: number },
  createdBy: string,
): CanvasNodeFields {
  const node = createEmptyNode('text', position, createdBy);
  return { ...node, data: { ...node.data, content: text } };
}
