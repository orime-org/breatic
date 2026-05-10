/**
 * Canvas write operations — all writes go directly to Yjs.
 *
 * Sibling hooks/contexts:
 * - `useCanvasData` — read nodes/edges/toasts (Context)
 * - **useCanvasActions** — write nodes/edges (Yjs)
 * - `useCanvasUI` (CanvasUIContext) — canvas-only UI state
 *   (overlay panel, comment mode)
 * - `useProjectLayout` (ProjectLayoutContext) — project page right
 *   editor panel state (cross-Space)
 */

import { useCallback, useRef } from 'react';
import * as Y from 'yjs';
import {
  getUserOrigin,
  noHistoryOrigin,
} from '@/data/yjs/canvas-space';
import type { CanvasSpaceManager } from '@/data/yjs/canvas-space';
import { useActiveCanvasSpace } from '@/domain/space/ActiveCanvasSpaceContext';
import { useCurrentUserId } from '@/domain/user/CurrentUserContext';
import type { NodeChange, EdgeChange, Connection, Node, Edge } from '@xyflow/react';
import type { NodeState, HandlingActor, CanvasNodeFields, AttachRef } from '@breatic/shared';

type HistoryOptions = { history?: 'default' | 'skip' };

function getOrigin(options?: HistoryOptions): string | symbol {
  return options?.history === 'skip' ? noHistoryOrigin : getUserOrigin();
}

/**
 * ReactFlow node type code by generative `outputType`. The atomic
 * three-body create (spec §10.13.7) drops a sibling asset node of
 * this type next to the generative source.
 */
const ASSET_TYPE_BY_OUTPUT: Record<'text' | 'image' | 'video' | 'audio', string> = {
  text: '1001',
  image: '1002',
  video: '1003',
  audio: '1004',
};

/**
 * Write spec/v13 audit metadata onto a fresh node's data Y.Map.
 *
 * Centralized here so every node-creation entrypoint (addNode /
 * setNodes / createDataNode / createGenerativeNode) stamps the same
 * three fields the same way. Caller-supplied data overrides the
 * defaults, e.g. a duplicate-node clone may keep the original
 * `createdAt` to preserve provenance.
 */
function stampAuditFields(
  dataMap: Y.Map<unknown>,
  data: Partial<CanvasNodeFields['data']> | undefined,
  currentUserId: string,
): void {
  dataMap.set('createdAt', data?.createdAt ?? Date.now());
  dataMap.set('createdBy', data?.createdBy ?? currentUserId);
  dataMap.set('locked', data?.locked ?? false);
}

// ── Generative reference rail sync helpers (spec §10.13.3 v13) ────
//
// All helpers below MUST be called inside an existing
// `mgr.doc.transact()` — they don't open their own transaction. The
// caller batches the edge mutation + references sync into one atomic
// op so collaborators never see a half-state where the rail row and
// the actual edge disagree.

/** Result codes used by tests / callers when a sync was a no-op. */
type RefSyncResult = 'synced' | 'target-not-generative' | 'missing';

/**
 * Add a `{ refId, sourceNodeId, addedAt }` row to the target
 * generative node's `references` Y.Array. Idempotent: if a row for
 * this `sourceNodeId` already exists, do nothing (handles duplicate
 * connect events without producing duplicate rail chips).
 */
function addReferenceRowIfGenerative(
  mgr: CanvasSpaceManager,
  sourceNodeId: string,
  targetNodeId: string,
): RefSyncResult {
  const targetNodeMap = mgr.nodesMap.get(targetNodeId);
  if (!(targetNodeMap instanceof Y.Map)) return 'missing';
  if (targetNodeMap.get('type') !== 'generative') return 'target-not-generative';
  const dataMap = targetNodeMap.get('data');
  if (!(dataMap instanceof Y.Map)) return 'missing';

  let refsArr = dataMap.get('references');
  if (!(refsArr instanceof Y.Array)) {
    refsArr = new Y.Array();
    dataMap.set('references', refsArr);
  }
  const arr = refsArr as Y.Array<Y.Map<unknown>>;

  // Dedupe by sourceNodeId — same upstream connecting twice (rare;
  // happens when an edge is removed and re-added) reuses the row.
  for (let i = 0; i < arr.length; i++) {
    const row = arr.get(i);
    if (row instanceof Y.Map && row.get('sourceNodeId') === sourceNodeId) {
      return 'synced';
    }
  }

  const row = new Y.Map();
  row.set('refId', crypto.randomUUID());
  row.set('sourceNodeId', sourceNodeId);
  row.set('addedAt', Date.now());
  arr.push([row]);
  return 'synced';
}

/**
 * Remove the rail row whose `sourceNodeId` matches. No-op when the
 * row isn't present (already cleaned up by an earlier sync).
 */
function removeReferenceRowIfGenerative(
  mgr: CanvasSpaceManager,
  sourceNodeId: string,
  targetNodeId: string,
): RefSyncResult {
  const targetNodeMap = mgr.nodesMap.get(targetNodeId);
  if (!(targetNodeMap instanceof Y.Map)) return 'missing';
  if (targetNodeMap.get('type') !== 'generative') return 'target-not-generative';
  const dataMap = targetNodeMap.get('data');
  if (!(dataMap instanceof Y.Map)) return 'missing';

  const refsArr = dataMap.get('references');
  if (!(refsArr instanceof Y.Array)) return 'synced';
  const arr = refsArr as Y.Array<Y.Map<unknown>>;

  for (let i = 0; i < arr.length; i++) {
    const row = arr.get(i);
    if (row instanceof Y.Map && row.get('sourceNodeId') === sourceNodeId) {
      arr.delete(i, 1);
      return 'synced';
    }
  }
  return 'synced';
}

/**
 * Read the source / target ids off an edge Y.Map. Returns `null` when
 * either side is missing — defensive against malformed edges, rare
 * but possible when a doc is hydrated mid-write.
 */
function readEdgeEndpoints(
  edgeMap: Y.Map<unknown>,
): { sourceId: string; targetId: string } | null {
  const sourceId = edgeMap.get('source');
  const targetId = edgeMap.get('target');
  if (typeof sourceId !== 'string' || typeof targetId !== 'string') return null;
  return { sourceId, targetId };
}

export function useCanvasActions() {
  // The active canvas Space manager comes from the page-level
  // `ActiveCanvasSpaceProvider`. We pin it on a ref so the
  // useCallback bodies below can keep their `[]` dep arrays — they
  // read `activeMgrRef.current` at call time and pick up the latest
  // manager identity automatically when the user switches Spaces.
  const activeMgr = useActiveCanvasSpace();
  const activeMgrRef = useRef<CanvasSpaceManager | null>(activeMgr);
  activeMgrRef.current = activeMgr;
  const getCanvasYjsManager = (): CanvasSpaceManager | null =>
    activeMgrRef.current;

  // Pinned on a ref for the same reason as the manager — keeps the
  // useCallback dep arrays empty while still observing user-id changes.
  const currentUserId = useCurrentUserId();
  const currentUserIdRef = useRef<string | null>(currentUserId);
  currentUserIdRef.current = currentUserId;
  const getCurrentUserId = (): string => currentUserIdRef.current ?? '';

  const addNode = useCallback(
    (node: Node, options?: { select?: boolean } & HistoryOptions) => {
      const mgr = getCanvasYjsManager();
      if (!mgr?.synced) return;

      const origin = getOrigin(options);
      const userId = getCurrentUserId();
      mgr.doc.transact(() => {
        const nodeMap = new Y.Map();
        nodeMap.set('id', node.id);
        nodeMap.set('type', node.type ?? '1002');
        const pos = new Y.Map();
        pos.set('x', node.position?.x ?? 0);
        pos.set('y', node.position?.y ?? 0);
        nodeMap.set('position', pos);

        const dataMap = new Y.Map();
        dataMap.set('name', node.data?.name ?? '');
        stampAuditFields(dataMap, node.data as Partial<CanvasNodeFields['data']> | undefined, userId);
        // Canvas-native schema: state machine, no history array
        dataMap.set('state', (node.data?.state as string) ?? 'idle');
        dataMap.set('attachments', new Y.Array());
        // Generative nodes may have a rich text prompt fragment
        if (node.data?.prompt !== undefined && node.data.prompt !== null) {
          dataMap.set('prompt', node.data.prompt);
        }
        nodeMap.set('data', dataMap);

        mgr.nodesMap.set(node.id, nodeMap);
      }, origin);
    },
    [],
  );

  const updateNode = useCallback(
    (nodeId: string, updates: Partial<Node>, options?: HistoryOptions) => {
      const mgr = getCanvasYjsManager();
      if (!mgr?.synced) return;

      const nodeMap = mgr.nodesMap.get(nodeId) as Y.Map<unknown> | undefined;
      if (!(nodeMap instanceof Y.Map)) return;

      const origin = getOrigin(options);
      mgr.doc.transact(() => {
        if (updates.position) {
          let pos = nodeMap.get('position') as Y.Map<unknown> | undefined;
          if (!(pos instanceof Y.Map)) {
            pos = new Y.Map();
            nodeMap.set('position', pos);
          }
          if (updates.position.x !== undefined) pos.set('x', updates.position.x);
          if (updates.position.y !== undefined) pos.set('y', updates.position.y);
        }

        const data = updates.data as Record<string, unknown> | undefined;
        if (data) {
          const dataMap = nodeMap.get('data') as Y.Map<unknown> | undefined;
          if (!(dataMap instanceof Y.Map)) return;

          if (data.name !== undefined) dataMap.set('name', data.name);
          // B.2 — `pickState` write path retired with the v12 chat
          // composer. Today's chips pick state (B.1) is per-user
          // React state in `ChipsPickContext`, never written to Yjs.
          // Do not persist old fields (state/content/coverUrl/runType) which are removed.
        }
      }, origin);
    },
    [],
  );

  const onNodesChange = useCallback(
    (changes: NodeChange[], options?: HistoryOptions) => {
      const mgr = getCanvasYjsManager();
      if (!mgr?.synced) return;

      const origin = getOrigin(options);
      mgr.doc.transact(() => {
        for (const change of changes) {
          if (change.type === 'position' && change.position) {
            const nodeMap = mgr.nodesMap.get(change.id) as Y.Map<unknown> | undefined;
            if (!(nodeMap instanceof Y.Map)) continue;
            let pos = nodeMap.get('position') as Y.Map<unknown> | undefined;
            if (!(pos instanceof Y.Map)) {
              pos = new Y.Map();
              nodeMap.set('position', pos);
            }
            pos.set('x', change.position.x);
            pos.set('y', change.position.y);
          } else if (change.type === 'remove') {
            mgr.nodesMap.delete(change.id);
            mgr.edgesMap.forEach((edgeMap, edgeId) => {
              if (edgeMap instanceof Y.Map) {
                const src = edgeMap.get('source') as string;
                const tgt = edgeMap.get('target') as string;
                if (src === change.id || tgt === change.id) {
                  mgr.edgesMap.delete(edgeId);
                }
              }
            });
          }
          // 'select' / 'dimensions' / 'reset' — ReactFlow handles internally
        }
      }, origin);
    },
    [],
  );

  const setNodes = useCallback(
    (next: Node[], options?: HistoryOptions) => {
      const mgr = getCanvasYjsManager();
      if (!mgr?.synced) return;

      const origin = getOrigin(options);
      const userId = getCurrentUserId();
      mgr.doc.transact(() => {
        mgr.nodesMap.forEach((_val, key) => mgr.nodesMap.delete(key));
        for (const node of next) {
          const nodeMap = new Y.Map();
          nodeMap.set('id', node.id);
          nodeMap.set('type', node.type ?? '1002');
          const pos = new Y.Map();
          pos.set('x', node.position?.x ?? 0);
          pos.set('y', node.position?.y ?? 0);
          nodeMap.set('position', pos);

          const dataMap = new Y.Map();
          dataMap.set('name', node.data?.name ?? '');
          stampAuditFields(dataMap, node.data as Partial<CanvasNodeFields['data']> | undefined, userId);
          // Canvas-native schema: state machine, no history array
          dataMap.set('state', (node.data?.state as string) ?? 'idle');
          dataMap.set('attachments', new Y.Array());
          if (node.data?.prompt !== undefined && node.data.prompt !== null) {
            dataMap.set('prompt', node.data.prompt);
          }
          nodeMap.set('data', dataMap);

          mgr.nodesMap.set(node.id, nodeMap);
        }
      }, origin);
    },
    [],
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      const mgr = getCanvasYjsManager();
      if (!mgr?.synced) return;

      mgr.doc.transact(() => {
        for (const change of changes) {
          if (change.type === 'remove') {
            // Sync references BEFORE deleting the edge — once we delete
            // the edge map the endpoint info is gone and we can't tell
            // which generative node lost an upstream.
            const edgeMap = mgr.edgesMap.get(change.id);
            if (edgeMap instanceof Y.Map) {
              const ends = readEdgeEndpoints(edgeMap);
              if (ends) {
                removeReferenceRowIfGenerative(mgr, ends.sourceId, ends.targetId);
              }
            }
            mgr.edgesMap.delete(change.id);
          }
        }
      }, getUserOrigin());
    },
    [],
  );

  const onConnect = useCallback(
    (connection: Connection) => {
      const mgr = getCanvasYjsManager();
      if (!mgr?.synced) return;

      const edgeId = `e-${connection.source}-${connection.sourceHandle ?? ''}-${connection.target}-${connection.targetHandle ?? ''}`;
      mgr.doc.transact(() => {
        const edgeMap = new Y.Map();
        edgeMap.set('id', edgeId);
        edgeMap.set('source', connection.source);
        edgeMap.set('target', connection.target);
        if (connection.sourceHandle) edgeMap.set('sourceHandle', connection.sourceHandle);
        if (connection.targetHandle) edgeMap.set('targetHandle', connection.targetHandle);
        // v13: every new edge starts as non-primary. The user picks a
        // primary downstream explicitly via the ↻ ▾ dropdown.
        const dataMap = new Y.Map();
        dataMap.set('isPrimary', false);
        edgeMap.set('data', dataMap);
        mgr.edgesMap.set(edgeId, edgeMap);

        // Sync the reference rail when target is a generative node
        // (spec §10.13.3 — connections are the single source of truth).
        addReferenceRowIfGenerative(mgr, connection.source, connection.target);
      }, getUserOrigin());
    },
    [],
  );

  const setEdges = useCallback(
    (next: Edge[]) => {
      const mgr = getCanvasYjsManager();
      if (!mgr?.synced) return;

      mgr.doc.transact(() => {
        // Bulk replace: clear every existing edge AND every generative
        // node's references rail, then rebuild from `next`. We can't
        // diff incrementally because callers like clipboard-paste pass
        // a totally new edge set with no relationship to the old one.
        mgr.edgesMap.forEach((_val, key) => mgr.edgesMap.delete(key));
        mgr.nodesMap.forEach((nodeMap) => {
          if (!(nodeMap instanceof Y.Map)) return;
          if (nodeMap.get('type') !== 'generative') return;
          const dataMap = nodeMap.get('data');
          if (!(dataMap instanceof Y.Map)) return;
          const refs = dataMap.get('references');
          if (refs instanceof Y.Array && refs.length > 0) {
            refs.delete(0, refs.length);
          }
        });

        for (const edge of next) {
          const edgeMap = new Y.Map();
          edgeMap.set('id', edge.id);
          edgeMap.set('source', edge.source);
          edgeMap.set('target', edge.target);
          if (edge.sourceHandle) edgeMap.set('sourceHandle', edge.sourceHandle);
          if (edge.targetHandle) edgeMap.set('targetHandle', edge.targetHandle);
          // Preserve `isPrimary` from caller-supplied edge.data when present
          // (e.g. duplicate / undo); otherwise default to non-primary.
          const callerIsPrimary = (edge.data as { isPrimary?: boolean } | undefined)?.isPrimary;
          const dataMap = new Y.Map();
          dataMap.set('isPrimary', Boolean(callerIsPrimary));
          edgeMap.set('data', dataMap);
          mgr.edgesMap.set(edge.id, edgeMap);
          addReferenceRowIfGenerative(mgr, edge.source, edge.target);
        }
      }, getUserOrigin());
    },
    [],
  );

  /**
   * Write `content` (and optional dimension fields) directly into a node's data Y.Map.
   *
   * Used by local upload flows (image/video/audio nodes) to set the result URL
   * in the canvas-native schema (no history indirection).
   *
   * Not undo-tracked (idempotent last-write-wins).
   *
   * @param nodeId - Canvas node to update.
   * @param fields - content URL and optional width/height/duration/cover_url.
   */
  const setNodeContent = useCallback(
    (nodeId: string, fields: {
      content: string;
      cover_url?: string;
      width?: number;
      height?: number;
      duration?: number;
    }) => {
      const mgr = getCanvasYjsManager();
      if (!mgr?.synced) return;

      const nodeMap = mgr.nodesMap.get(nodeId) as Y.Map<unknown> | undefined;
      if (!(nodeMap instanceof Y.Map)) return;

      mgr.doc.transact(() => {
        const dataMap = nodeMap.get('data') as Y.Map<unknown> | undefined;
        if (!(dataMap instanceof Y.Map)) return;
        dataMap.set('content', fields.content);
        if (fields.cover_url !== undefined) dataMap.set('cover_url', fields.cover_url);
        if (fields.width !== undefined) dataMap.set('width', fields.width);
        if (fields.height !== undefined) dataMap.set('height', fields.height);
        if (fields.duration !== undefined) dataMap.set('duration', fields.duration);
      }, noHistoryOrigin);
    },
    [],
  );

  /**
   * Create a data node (image/video/audio/text/etc.) in `nodesMap`.
   *
   * Frontend is the only actor that creates nodes (universal rule).
   * Backend can only modify `state` / content fields via the event bus.
   *
   * @param opts.type - ReactFlow node type string (e.g. '1002' for image).
   * @param opts.sourceNodeId - Parent node id when produced by mini-tool.
   * @param opts.position - Canvas coordinates (defaults to 0,0).
   * @param opts.data - Optional partial data fields to seed (content, name, etc.).
   * @returns The new node's UUID v4 id.
   */
  const createDataNode = useCallback(
    (opts: {
      type: string;
      sourceNodeId?: string;
      position?: { x: number; y: number };
      data?: Partial<CanvasNodeFields['data']>;
    }): string => {
      const mgr = getCanvasYjsManager();
      const nodeId = crypto.randomUUID();
      if (!mgr?.synced) return nodeId;

      const userId = getCurrentUserId();
      mgr.doc.transact(() => {
        const nodeMap = new Y.Map();
        nodeMap.set('id', nodeId);
        nodeMap.set('type', opts.type);
        const pos = new Y.Map();
        pos.set('x', opts.position?.x ?? 0);
        pos.set('y', opts.position?.y ?? 0);
        nodeMap.set('position', pos);

        const dataMap = new Y.Map();
        dataMap.set('name', opts.data?.name ?? '');
        stampAuditFields(dataMap, opts.data, userId);
        dataMap.set('state', 'idle');
        dataMap.set('attachments', new Y.Array<AttachRef>());
        if (opts.data?.content !== undefined) dataMap.set('content', opts.data.content);
        if (opts.data?.cover_url !== undefined) dataMap.set('cover_url', opts.data.cover_url);
        if (opts.data?.width !== undefined) dataMap.set('width', opts.data.width);
        if (opts.data?.height !== undefined) dataMap.set('height', opts.data.height);
        if (opts.data?.duration !== undefined) dataMap.set('duration', opts.data.duration);
        if (opts.sourceNodeId !== undefined) dataMap.set('sourceNodeId', opts.sourceNodeId);
        if (opts.data?.operation !== undefined) dataMap.set('operation', opts.data.operation);
        if (opts.data?.operationParams !== undefined) dataMap.set('operationParams', opts.data.operationParams);
        nodeMap.set('data', dataMap);

        mgr.nodesMap.set(nodeId, nodeMap);
      }, getUserOrigin());

      return nodeId;
    },
    [],
  );

  /**
   * Create a generative node + its initial primary asset child + the
   * primary edge — atomic three-body op per spec §10.13.7 v13.
   *
   * The spec requires a generative node to land with at least one
   * downstream so the user can immediately ▶ generate / ↻ regenerate
   * without extra wiring. This hook does it all in one Yjs
   * transaction so collaborators never see a half-state (e.g. a
   * generative node whose first regenerate target hasn't been
   * created yet).
   *
   * `outputType` is fixed at creation; changing modality means
   * deleting + creating a new generative node. The asset child's
   * type is derived from `outputType` (image → '1002', video →
   * '1003', audio → '1004', text → '1001').
   *
   * @param opts.outputType - Asset modality this node will produce.
   * @param opts.kind - Sub-task variant (image: 文生图/图生图; audio: music/tts/旋律/环境音; …).
   * @param opts.model - Optional initial model id from config/models/*.yaml.
   * @param opts.params - Optional model-specific params.
   * @param opts.position - Canvas coordinates of the generative node (defaults to 0,0). The asset child sits at +540px right (generative width 480 + 60px gap, spec §10.13.7).
   * @returns The trio of ids the caller may need for downstream UX (selection, focus, navigation).
   */
  const createGenerativeNode = useCallback(
    (opts: {
      outputType: 'text' | 'image' | 'video' | 'audio';
      kind: string;
      model?: string;
      params?: Record<string, unknown>;
      position?: { x: number; y: number };
    }): { generativeNodeId: string; assetNodeId: string; primaryEdgeId: string } => {
      const mgr = getCanvasYjsManager();
      const generativeNodeId = crypto.randomUUID();
      const assetNodeId = crypto.randomUUID();
      const primaryEdgeId = `e-${generativeNodeId}-${assetNodeId}-primary`;
      if (!mgr?.synced) return { generativeNodeId, assetNodeId, primaryEdgeId };

      const userId = getCurrentUserId();
      const genX = opts.position?.x ?? 0;
      const genY = opts.position?.y ?? 0;
      // Asset child sits to the right of the generative node — width
      // 480 (GENERATIVE_NODE_WIDTH constant) + 60px gap = 540px.
      const assetX = genX + 540;
      const assetY = genY;

      mgr.doc.transact(() => {
        // ── (a) generative node ──────────────────────────────
        const genMap = new Y.Map();
        genMap.set('id', generativeNodeId);
        genMap.set('type', 'generative');
        const genPos = new Y.Map();
        genPos.set('x', genX);
        genPos.set('y', genY);
        genMap.set('position', genPos);

        const genData = new Y.Map();
        genData.set('name', '');
        stampAuditFields(genData, undefined, userId);
        genData.set('state', 'idle');
        genData.set('attachments', new Y.Array<AttachRef>());
        genData.set('outputType', opts.outputType);
        genData.set('kind', opts.kind);
        genData.set('prompt', new Y.XmlFragment());
        // F3: references rail Y.Array now lives in Yjs (sync'd in
        // onConnect / onEdgesChange / setEdges / deleteNodeAndEdges).
        genData.set('references', new Y.Array());
        if (opts.model !== undefined) genData.set('model', opts.model);
        if (opts.params !== undefined) genData.set('params', opts.params);
        genMap.set('data', genData);
        mgr.nodesMap.set(generativeNodeId, genMap);

        // ── (b) initial asset child ──────────────────────────
        const assetType = ASSET_TYPE_BY_OUTPUT[opts.outputType];
        const assetMap = new Y.Map();
        assetMap.set('id', assetNodeId);
        assetMap.set('type', assetType);
        const assetPos = new Y.Map();
        assetPos.set('x', assetX);
        assetPos.set('y', assetY);
        assetMap.set('position', assetPos);

        const assetData = new Y.Map();
        assetData.set('name', `${opts.outputType} v1`);
        stampAuditFields(assetData, undefined, userId);
        assetData.set('state', 'idle');
        assetData.set('attachments', new Y.Array<AttachRef>());
        assetData.set('sourceNodeId', generativeNodeId);
        assetMap.set('data', assetData);
        mgr.nodesMap.set(assetNodeId, assetMap);

        // ── (c) primary edge ─────────────────────────────────
        const edgeMap = new Y.Map();
        edgeMap.set('id', primaryEdgeId);
        edgeMap.set('source', generativeNodeId);
        edgeMap.set('target', assetNodeId);
        const edgeData = new Y.Map();
        edgeData.set('isPrimary', true);
        edgeMap.set('data', edgeData);
        mgr.edgesMap.set(primaryEdgeId, edgeMap);

        // No reference rail sync needed — the edge target (asset) is
        // not a generative node, so it has no reference rail.
      }, getUserOrigin());

      return { generativeNodeId, assetNodeId, primaryEdgeId };
    },
    [],
  );

  /**
   * Atomically swap the primary downstream of a generative node
   * (spec §10.13.5 v13). At most one outgoing edge per source can
   * carry `data.isPrimary === true`; this helper enforces that
   * invariant in a single transaction so collaborators never see
   * a moment when zero or two edges are primary.
   *
   * @param generativeNodeId - The source node whose outgoing edges are reshuffled.
   * @param primaryEdgeId - The new primary edge id, or `null` to clear (no primary downstream — the ↻ button degrades to ✨新建).
   */
  const setPrimaryDownstreamEdge = useCallback(
    (generativeNodeId: string, primaryEdgeId: string | null): void => {
      const mgr = getCanvasYjsManager();
      if (!mgr?.synced) return;

      mgr.doc.transact(() => {
        mgr.edgesMap.forEach((edgeMap, edgeId) => {
          if (!(edgeMap instanceof Y.Map)) return;
          if (edgeMap.get('source') !== generativeNodeId) return;
          const dataMap = edgeMap.get('data');
          if (dataMap instanceof Y.Map) {
            dataMap.set('isPrimary', edgeId === primaryEdgeId);
          } else {
            // Older edges without a `data` map — bring them up to v13
            // shape so the invariant holds going forward.
            const newData = new Y.Map();
            newData.set('isPrimary', edgeId === primaryEdgeId);
            edgeMap.set('data', newData);
          }
        });
      }, getUserOrigin());
    },
    [],
  );

  /**
   * ▶ 新增版本 — create a new sibling asset node connected to the
   * generative node by a non-primary edge (spec §10.13.4 v13).
   *
   * The user invokes this when they want to keep the existing
   * primary downstream untouched and produce another version.
   * The new edge is **not** primary; the user can later promote it
   * via the ↻ ▾ dropdown.
   *
   * @param generativeNodeId - The source generative node.
   * @returns The new asset node id + edge id (caller posts to /api/tasks with `target_node_id: assetNodeId`).
   */
  const addAppendVersion = useCallback(
    (generativeNodeId: string): { assetNodeId: string; edgeId: string } => {
      const mgr = getCanvasYjsManager();
      const assetNodeId = crypto.randomUUID();
      const edgeId = `e-${generativeNodeId}-${assetNodeId}-${crypto.randomUUID().slice(0, 8)}`;
      if (!mgr?.synced) return { assetNodeId, edgeId };

      const genMap = mgr.nodesMap.get(generativeNodeId);
      if (!(genMap instanceof Y.Map)) return { assetNodeId, edgeId };
      const genData = genMap.get('data');
      if (!(genData instanceof Y.Map)) return { assetNodeId, edgeId };

      const outputType =
        (genData.get('outputType') as 'text' | 'image' | 'video' | 'audio' | undefined) ?? 'image';
      const assetType = ASSET_TYPE_BY_OUTPUT[outputType];
      // Stagger versions vertically below the primary asset slot so
      // they don't pile up. We can't read the live ReactFlow node
      // positions from inside the Yjs world cheaply; the caller
      // (GenerativeNode) ought to override `position` once a layout
      // pass is in place. F3 simple stagger: count existing outgoing
      // edges and offset by 100 * count.
      let outgoingCount = 0;
      mgr.edgesMap.forEach((edgeMap) => {
        if (edgeMap instanceof Y.Map && edgeMap.get('source') === generativeNodeId) {
          outgoingCount++;
        }
      });

      const genPos = genMap.get('position');
      const baseX = genPos instanceof Y.Map ? ((genPos.get('x') as number) ?? 0) : 0;
      const baseY = genPos instanceof Y.Map ? ((genPos.get('y') as number) ?? 0) : 0;
      const assetX = baseX + 540;
      const assetY = baseY + outgoingCount * 100;

      const userId = getCurrentUserId();
      mgr.doc.transact(() => {
        const assetMap = new Y.Map();
        assetMap.set('id', assetNodeId);
        assetMap.set('type', assetType);
        const assetPos = new Y.Map();
        assetPos.set('x', assetX);
        assetPos.set('y', assetY);
        assetMap.set('position', assetPos);

        const assetData = new Y.Map();
        assetData.set('name', `${outputType} v${outgoingCount + 1}`);
        stampAuditFields(assetData, undefined, userId);
        assetData.set('state', 'idle');
        assetData.set('attachments', new Y.Array<AttachRef>());
        assetData.set('sourceNodeId', generativeNodeId);
        assetMap.set('data', assetData);
        mgr.nodesMap.set(assetNodeId, assetMap);

        const edgeMap = new Y.Map();
        edgeMap.set('id', edgeId);
        edgeMap.set('source', generativeNodeId);
        edgeMap.set('target', assetNodeId);
        const edgeData = new Y.Map();
        edgeData.set('isPrimary', false);
        edgeMap.set('data', edgeData);
        mgr.edgesMap.set(edgeId, edgeMap);
      }, getUserOrigin());

      return { assetNodeId, edgeId };
    },
    [],
  );

  /**
   * ↻ degenerate "✨ 新建" path (spec §10.13.4 v13) — invoked when
   * the user clicks ↻ but the generative node has no primary
   * downstream. Same as {@link addAppendVersion} but the new edge
   * is set as the primary, and any other outgoing edges are demoted
   * to non-primary in the same transaction (defensive — no other
   * edge should be primary either, but enforce the invariant).
   *
   * @param generativeNodeId - The source generative node.
   * @returns The new asset node id + edge id.
   */
  const addAppendVersionAsPrimary = useCallback(
    (generativeNodeId: string): { assetNodeId: string; edgeId: string } => {
      const mgr = getCanvasYjsManager();
      const assetNodeId = crypto.randomUUID();
      const edgeId = `e-${generativeNodeId}-${assetNodeId}-${crypto.randomUUID().slice(0, 8)}`;
      if (!mgr?.synced) return { assetNodeId, edgeId };

      const genMap = mgr.nodesMap.get(generativeNodeId);
      if (!(genMap instanceof Y.Map)) return { assetNodeId, edgeId };
      const genData = genMap.get('data');
      if (!(genData instanceof Y.Map)) return { assetNodeId, edgeId };

      const outputType =
        (genData.get('outputType') as 'text' | 'image' | 'video' | 'audio' | undefined) ?? 'image';
      const assetType = ASSET_TYPE_BY_OUTPUT[outputType];

      let outgoingCount = 0;
      mgr.edgesMap.forEach((edgeMap) => {
        if (edgeMap instanceof Y.Map && edgeMap.get('source') === generativeNodeId) {
          outgoingCount++;
        }
      });

      const genPos = genMap.get('position');
      const baseX = genPos instanceof Y.Map ? ((genPos.get('x') as number) ?? 0) : 0;
      const baseY = genPos instanceof Y.Map ? ((genPos.get('y') as number) ?? 0) : 0;
      const assetX = baseX + 540;
      const assetY = baseY + outgoingCount * 100;

      const userId = getCurrentUserId();
      mgr.doc.transact(() => {
        // Demote all existing outgoing edges to non-primary, then add
        // the new edge as primary. Single transaction → invariant
        // (≤ 1 primary per source) holds at every observable moment.
        mgr.edgesMap.forEach((edgeMap) => {
          if (!(edgeMap instanceof Y.Map)) return;
          if (edgeMap.get('source') !== generativeNodeId) return;
          const dataMap = edgeMap.get('data');
          if (dataMap instanceof Y.Map) dataMap.set('isPrimary', false);
        });

        const assetMap = new Y.Map();
        assetMap.set('id', assetNodeId);
        assetMap.set('type', assetType);
        const assetPos = new Y.Map();
        assetPos.set('x', assetX);
        assetPos.set('y', assetY);
        assetMap.set('position', assetPos);

        const assetData = new Y.Map();
        assetData.set('name', `${outputType} v${outgoingCount + 1}`);
        stampAuditFields(assetData, undefined, userId);
        assetData.set('state', 'idle');
        assetData.set('attachments', new Y.Array<AttachRef>());
        assetData.set('sourceNodeId', generativeNodeId);
        assetMap.set('data', assetData);
        mgr.nodesMap.set(assetNodeId, assetMap);

        const edgeMap = new Y.Map();
        edgeMap.set('id', edgeId);
        edgeMap.set('source', generativeNodeId);
        edgeMap.set('target', assetNodeId);
        const edgeData = new Y.Map();
        edgeData.set('isPrimary', true);
        edgeMap.set('data', edgeData);
        mgr.edgesMap.set(edgeId, edgeMap);
      }, getUserOrigin());

      return { assetNodeId, edgeId };
    },
    [],
  );

  /**
   * Create an edge between two nodes in `edgesMap`.
   *
   * @param opts.sourceNodeId - Source node id.
   * @param opts.targetNodeId - Target node id.
   * @param opts.label - Optional display label.
   * @returns The new edge's id.
   */
  const createEdge = useCallback(
    (opts: {
      sourceNodeId: string;
      targetNodeId: string;
      label?: string;
      /** When true, marks this edge as the primary downstream (spec §10.13.2 v13). Default false. */
      isPrimary?: boolean;
    }): string => {
      const mgr = getCanvasYjsManager();
      const edgeId = `e-${opts.sourceNodeId}-${opts.targetNodeId}-${crypto.randomUUID().slice(0, 8)}`;
      if (!mgr?.synced) return edgeId;

      mgr.doc.transact(() => {
        const edgeMap = new Y.Map();
        edgeMap.set('id', edgeId);
        edgeMap.set('source', opts.sourceNodeId);
        edgeMap.set('target', opts.targetNodeId);
        if (opts.label !== undefined) edgeMap.set('label', opts.label);
        const dataMap = new Y.Map();
        dataMap.set('isPrimary', Boolean(opts.isPrimary));
        edgeMap.set('data', dataMap);
        mgr.edgesMap.set(edgeId, edgeMap);
      }, getUserOrigin());

      return edgeId;
    },
    [],
  );

  /**
   * Delete a node and all edges referencing it from `nodesMap` / `edgesMap`.
   *
   * Per spec: throws when the node's state is `'handling'` to prevent
   * data loss from racing delete + completion.
   *
   * @param nodeId - Node to delete.
   * @throws Error when node state is 'handling'.
   */
  const deleteNodeAndEdges = useCallback(
    (nodeId: string): void => {
      const mgr = getCanvasYjsManager();
      if (!mgr?.synced) return;

      const nodeMap = mgr.nodesMap.get(nodeId) as Y.Map<unknown> | undefined;
      if (nodeMap instanceof Y.Map) {
        const dataMap = nodeMap.get('data') as Y.Map<unknown> | undefined;
        if (dataMap instanceof Y.Map) {
          const state = dataMap.get('state') as string | undefined;
          if (state === 'handling') {
            throw new Error(`Cannot delete node ${nodeId}: node is currently handling.`);
          }
        }
      }

      mgr.doc.transact(() => {
        mgr.nodesMap.delete(nodeId);
        mgr.edgesMap.forEach((edgeMap, edgeId) => {
          if (edgeMap instanceof Y.Map) {
            const src = edgeMap.get('source') as string;
            const tgt = edgeMap.get('target') as string;
            if (src === nodeId || tgt === nodeId) {
              // Sync references rail before deleting the edge:
              //  - if `tgt` is a generative node and `src !== nodeId`,
              //    that generative loses a real upstream → drop row
              //  - if `src` is a generative node, `tgt` was an asset
              //    child being deleted alongside; no rail to sync (the
              //    generative isn't the target of the edge)
              if (tgt !== nodeId) {
                removeReferenceRowIfGenerative(mgr, src, tgt);
              }
              mgr.edgesMap.delete(edgeId);
            }
          }
        });
      }, getUserOrigin());
    },
    [],
  );

  /**
   * Transition a node's state in Yjs.
   *
   * Used by frontend when a POST returns 202+task_id — transition from
   * localPending to 'handling' in Yjs so collaborators can observe.
   *
   * @param nodeId - Target node.
   * @param state - New Yjs-shared state.
   * @param handlingBy - Required when state === 'handling'; identifies the actor.
   */
  const setNodeState = useCallback(
    (nodeId: string, state: NodeState, handlingBy?: HandlingActor): void => {
      const mgr = getCanvasYjsManager();
      if (!mgr?.synced) return;

      const nodeMap = mgr.nodesMap.get(nodeId) as Y.Map<unknown> | undefined;
      if (!(nodeMap instanceof Y.Map)) return;

      mgr.doc.transact(() => {
        const dataMap = nodeMap.get('data') as Y.Map<unknown> | undefined;
        if (!(dataMap instanceof Y.Map)) return;
        dataMap.set('state', state);
        if (state === 'handling' && handlingBy) {
          dataMap.set('handlingBy', handlingBy);
          dataMap.delete('errorMessage'); // clear previous error on new attempt
        } else if (state === 'idle') {
          dataMap.delete('handlingBy');
        }
      }, noHistoryOrigin);
    },
    [],
  );

  /**
   * Set an error message on a node (state stays 'idle', error is visible to all).
   *
   * Backend-failed nodes: visible to all collaborators, deletable by anyone.
   * Typically applied by the collab consumer via the event bus; exposed here
   * for frontend error propagation edge cases (e.g., retry UX before POST).
   *
   * @param nodeId - Target node.
   * @param errorMessage - Human-readable error description.
   */
  const setNodeError = useCallback(
    (nodeId: string, errorMessage: string): void => {
      const mgr = getCanvasYjsManager();
      if (!mgr?.synced) return;

      const nodeMap = mgr.nodesMap.get(nodeId) as Y.Map<unknown> | undefined;
      if (!(nodeMap instanceof Y.Map)) return;

      mgr.doc.transact(() => {
        const dataMap = nodeMap.get('data') as Y.Map<unknown> | undefined;
        if (!(dataMap instanceof Y.Map)) return;
        dataMap.set('state', 'idle');
        dataMap.set('errorMessage', errorMessage);
        dataMap.delete('handlingBy');
      }, noHistoryOrigin);
    },
    [],
  );

  const undo = useCallback(() => {
    const mgr = getCanvasYjsManager();
    if (!mgr || mgr.undoManager.undoStack.length === 0) return false;
    mgr.undoManager.undo();
    return true;
  }, []);

  const redo = useCallback(() => {
    const mgr = getCanvasYjsManager();
    if (!mgr || mgr.undoManager.redoStack.length === 0) return false;
    mgr.undoManager.redo();
    return true;
  }, []);

  return {
    addNode,
    updateNode,
    onNodesChange,
    onEdgesChange,
    onConnect,
    setNodes,
    setEdges,
    undo,
    redo,
    // Canvas-native schema helpers
    setNodeContent,
    createDataNode,
    createGenerativeNode,
    createEdge,
    deleteNodeAndEdges,
    setNodeState,
    setNodeError,
    // Generative dual-button + primary downstream (spec §10.13.4 / §10.13.5)
    setPrimaryDownstreamEdge,
    addAppendVersion,
    addAppendVersionAsPrimary,
  };
}
