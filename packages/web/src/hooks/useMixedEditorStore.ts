import { useCallback } from 'react';
import { useDispatch, useSelector, useStore, shallowEqual } from 'react-redux';
import { nanoid } from 'nanoid';
import type { Connection, Edge, EdgeChange, Node, NodeChange } from '@xyflow/react';
import type { RootState } from '@/store';
import {
  setMixedEditorActiveTool,
  setMixedEditorExpandViewportLock,
  clearMixedEditorExpandLock,
  pruneMixedEditorExpandLocks,
  applyMixedEditorNodeChanges,
  appendMixedEditorNodes,
  patchMixedEditorNodeData,
  updateMixedEditorNode,
  removeMixedEditorNode,
  setMixedEditorNodes,
  applyMixedEditorEdgeChanges,
  addMixedEditorEdge,
  toggleMixedEditorFavoriteAsset,
} from '@/store/modules/mixedEditor';
import type {
  MixedEditorActiveTool,
  MixedEditorFavoriteAsset,
  ToggleMixedEditorFavoritePayload,
} from '@/store/modules/mixedEditor';
import { message } from '@/components/base/message';
import { getImageMeta, getVideoMeta } from '@/utils/mediaUtils';
import { noHistoryOrigin } from '@/utils/yjsProjectManager';
import { requestNextYjsWriteOrigin } from '@/utils/yjsHistoryControl';
import type {
  EditorTool,
  ImageEditorNodeDataPatch,
  ImageFlowNodeData,
} from '@/apps/project/components/mixedEditor/types';
import {
  createEditorAudioNodeData,
  createEditorImageNodeData,
  createEditorVideoNodeData,
  imageEditorAudioNodeType,
  imageEditorImageNodeType,
  imageEditorVideoNodeType,
} from '@/apps/project/components/mixedEditor/types';

type HistoryOptions = { history?: 'default' | 'skip' };

const imageFlowDefaultWidth = 260;
const imageFlowDefaultHeight = 160;
const audioFlowDefaultWidth = 300;
const audioFlowDefaultHeight = 250;
const uploadGap = 30;
const flowTopOffset = 10;

const calcNodeSizeFromImage = (naturalWidth?: number | null, naturalHeight?: number | null) => {
  const w = naturalWidth ?? 0;
  const h = naturalHeight ?? 0;
  if (w <= 0 || h <= 0) {
    return { width: imageFlowDefaultWidth, height: imageFlowDefaultHeight };
  }
  const isLandscape = w >= h;
  if (isLandscape) {
    const height = Math.max(Math.round(imageFlowDefaultWidth * (h / w)), imageFlowDefaultHeight);
    const width = Math.round(height * (w / h));
    return { width, height };
  }
  return {
    width: imageFlowDefaultWidth,
    height: Math.round(imageFlowDefaultWidth * (h / w)),
  };
};

const nodeSizeFromResultOrFallback = (
  resultImageSize: { width: number; height: number } | undefined,
  fallbackWidth: number,
  fallbackHeight: number,
): { width: number; height: number } => {
  if (resultImageSize != null) {
    return calcNodeSizeFromImage(resultImageSize.width, resultImageSize.height);
  }
  return { width: fallbackWidth, height: fallbackHeight };
};

const getNextStackY = (nodes: Node[]): number => {
  if (!nodes.length) return flowTopOffset;
  let maxBottom = 0;
  for (const n of nodes) {
    const st = (n.style ?? {}) as { height?: number };
    const h = typeof st.height === 'number' ? st.height : imageFlowDefaultHeight;
    const bottom = n.position.y + h;
    if (bottom > maxBottom) maxBottom = bottom;
  }
  return maxBottom + uploadGap;
};

const inheritParentFieldsFromNode = (source: Node): Pick<Partial<Node>, 'parentId' | 'extent'> => {
  const out: Pick<Partial<Node>, 'parentId' | 'extent'> = {};
  if (source.parentId == null) {
    return out;
  }
  out.parentId = source.parentId;
  if (source.extent !== undefined) {
    out.extent = source.extent;
  }
  return out;
};

const selectMixedEditorNodes = (s: RootState) => s.mixedEditor.nodes ?? [];
const selectMixedEditorEdges = (s: RootState) => s.mixedEditor.edges ?? [];
const selectMixedEditorActiveTool = (s: RootState) => s.mixedEditor.activeTool;
const selectExpandViewportLocked = (s: RootState) => Object.keys(s.mixedEditor.expandViewportLocks ?? {}).length > 0;
const selectMixedEditorFavoriteAssets = (s: RootState) => s.mixedEditor.favoriteAssets ?? [];

export interface UseMixedEditorStoreResult {
  nodes: Node[];
  edges: Edge[];
  activeTool: EditorTool;
  setActiveTool: (tool: EditorTool) => void;
  onNodesChange: (changes: NodeChange[], options?: HistoryOptions) => void;
  onEdgesChange: (changes: EdgeChange[]) => void;
  onConnect: (connection: Connection) => void;
  setNodes: (nodes: Node[], options?: HistoryOptions) => void;
  updateNode: (nodeId: string, updates: Partial<Node>, options?: HistoryOptions) => void;
  updateNodeData: (nodeId: string, patch: ImageEditorNodeDataPatch, options?: HistoryOptions) => void;
  setNodeDraggable: (nodeId: string, draggable: boolean) => void;
  replaceNodeWithFile: (nodeId: string, file: File) => Promise<void>;
  removeNode: (nodeId: string) => void;
  onCropNode: (nodeId: string) => void;
  copyNodeImageSrc: (nodeId: string) => void;
  createNewNodeBelow: (nodeId: string) => void;
  createInpaintResultNodeRight: (
    sourceNodeId: string,
    nextImageSrc: string,
    delayMs?: number,
    resultImageSize?: { width: number; height: number },
  ) => void;
  createInpaintResultNodesRight: (
    sourceNodeId: string,
    nextImageSrc: string,
    count: number,
    delayMs?: number,
    resultImageSize?: { width: number; height: number },
  ) => void;
  createEnhanceResultNodesRight: (
    sourceNodeId: string,
    results: Array<{ row: number; col: number; src: string; width: number; height: number }>,
    delayMs?: number,
  ) => void;
  createCutVideoResultNodesRight: (
    sourceNodeId: string,
    payload: { segments: Array<{ start: number; end: number }>; cutMarkers?: Array<{ id: string; progressPct: number }> },
    nextVideoSrc: string,
    delayMs?: number,
  ) => void;
  importImagesFromFiles: (files: File[], options?: { viewportCenterFlow: { x: number; y: number } }) => Promise<void>;
  importVideosFromFiles: (files: File[], options?: { viewportCenterFlow: { x: number; y: number } }) => Promise<void>;
  importAudiosFromFiles: (files: File[], options?: { viewportCenterFlow: { x: number; y: number } }) => Promise<void>;
  setExpandViewportLock: (nodeId: string, locked: boolean) => void;
  expandViewportLocked: boolean;
  favoriteAssets: MixedEditorFavoriteAsset[];
  toggleFavoriteAsset: (payload: ToggleMixedEditorFavoritePayload) => void;
}

export const useMixedEditorStore = (): UseMixedEditorStoreResult => {
  const dispatch = useDispatch();
  const reduxStore = useStore<RootState>();
  const nodes = useSelector(selectMixedEditorNodes, shallowEqual);
  const edges = useSelector(selectMixedEditorEdges, shallowEqual);
  const activeTool = useSelector(selectMixedEditorActiveTool) as EditorTool;
  const expandViewportLocked = useSelector(selectExpandViewportLocked);
  const favoriteAssets = useSelector(selectMixedEditorFavoriteAssets, shallowEqual);

  const updateNodeData = useCallback(
    (nodeId: string, patch: ImageEditorNodeDataPatch, options?: HistoryOptions) => {
      if (options?.history === 'skip') {
        requestNextYjsWriteOrigin(noHistoryOrigin);
      }
      dispatch(patchMixedEditorNodeData({ nodeId, patch }));
    },
    [dispatch],
  );

  const setNodes = useCallback(
    (nextNodes: Node[], options?: HistoryOptions) => {
      if (options?.history === 'skip') {
        requestNextYjsWriteOrigin(noHistoryOrigin);
      }
      dispatch(setMixedEditorNodes(nextNodes));
      dispatch(pruneMixedEditorExpandLocks(nextNodes.map((n) => n.id)));
    },
    [dispatch],
  );

  const updateNode = useCallback(
    (nodeId: string, updates: Partial<Node>, options?: HistoryOptions) => {
      if (options?.history === 'skip') {
        requestNextYjsWriteOrigin(noHistoryOrigin);
      }
      dispatch(updateMixedEditorNode({ nodeId, updates }));
    },
    [dispatch],
  );

  const setNodeDraggable = useCallback(
    (nodeId: string, draggable: boolean) => {
      dispatch(updateMixedEditorNode({ nodeId, updates: { draggable } }));
    },
    [dispatch],
  );

  const removeNode = useCallback(
    (nodeId: string) => {
      dispatch(removeMixedEditorNode(nodeId));
      dispatch(clearMixedEditorExpandLock(nodeId));
    },
    [dispatch],
  );

  const onCropNode = useCallback(
    (_nodeId: string) => {
      dispatch(setMixedEditorActiveTool('crop'));
    },
    [dispatch],
  );

  const replaceNodeWithFile = useCallback(
    async (nodeId: string, file: File) => {
      const toDataUrl = (f: File) =>
        new Promise<string>((resolve) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result ?? ''));
          reader.readAsDataURL(f);
        });
      const src = await toDataUrl(file);
      const meta = await getImageMeta(file);
      const nextSize = calcNodeSizeFromImage(meta.width, meta.height);
      dispatch(
        updateMixedEditorNode({
          nodeId,
          updates: {
            style: {
              width: nextSize.width,
              height: nextSize.height,
            },
            data: createEditorImageNodeData(file.name, src),
          },
        }),
      );
    },
    [dispatch],
  );

  const copyNodeImageSrc = useCallback(
    (nodeId: string) => {
      const node = (reduxStore.getState().mixedEditor.nodes ?? []).find((n) => n.id === nodeId);
      const d = node?.data as ImageFlowNodeData | undefined;
      const src = d?.content;
      if (!src) return;
      void navigator.clipboard.writeText(String(src));
      message.success('Copied');
    },
    [reduxStore],
  );

  const createNewNodeBelow = useCallback(
    (nodeId: string) => {
      const allNodes = reduxStore.getState().mixedEditor.nodes ?? [];
      const source = allNodes.find((n) => n.id === nodeId);
      if (!source) return;
      const data = source.data as ImageFlowNodeData;
      const { content: src, name } = data;
      if (!src) return;

      const sourceStyle = (source.style ?? {}) as { width?: number; height?: number };
      const copyW = typeof sourceStyle.width === 'number' ? sourceStyle.width : imageFlowDefaultWidth;
      const copyH = typeof sourceStyle.height === 'number' ? sourceStyle.height : imageFlowDefaultHeight;
      const sourceH = typeof sourceStyle.height === 'number' ? sourceStyle.height : imageFlowDefaultHeight;

      const nid = `image-flow-${nanoid(12)}`;
      const x = source.position.x;
      const y = source.position.y + sourceH + uploadGap;

      const newNode: Node<ImageFlowNodeData> = {
        id: nid,
        type: imageEditorImageNodeType,
        position: { x, y },
        selected: true,
        style: { width: copyW, height: copyH },
        data: createEditorImageNodeData(`${name} (copy)`, src),
      };

      const deselectChanges = allNodes
        .filter((n) => n.selected)
        .map((n) => ({ type: 'select' as const, id: n.id, selected: false }));
      if (deselectChanges.length > 0) dispatch(applyMixedEditorNodeChanges(deselectChanges));
      dispatch(appendMixedEditorNodes([newNode]));
    },
    [dispatch, reduxStore],
  );

  const createInpaintResultNodeRight = useCallback(
    (
      sourceNodeId: string,
      nextImageSrc: string,
      delayMs: number = 3000,
      resultImageSize?: { width: number; height: number },
    ) => {
      const allNodes = reduxStore.getState().mixedEditor.nodes ?? [];
      const source = allNodes.find((n) => n.id === sourceNodeId);
      if (!source) return;

      const data = source.data as ImageFlowNodeData;
      const name = data.name || 'Image';

      const sourceStyle = (source.style ?? {}) as { width?: number; height?: number };
      const copyW = typeof sourceStyle.width === 'number' ? sourceStyle.width : imageFlowDefaultWidth;
      const copyH = typeof sourceStyle.height === 'number' ? sourceStyle.height : imageFlowDefaultHeight;

      const nodeSize = nodeSizeFromResultOrFallback(resultImageSize, copyW, copyH);

      const nid = `image-flow-${nanoid(12)}`;
      const x = source.position.x + copyW + uploadGap;
      const y = source.position.y;

      const inheritParentFromSource = inheritParentFieldsFromNode(source);

      const newNode: Node<ImageFlowNodeData> = {
        id: nid,
        type: imageEditorImageNodeType,
        position: { x, y },
        selected: true,
        style: { width: nodeSize.width, height: nodeSize.height },
        data: createEditorImageNodeData(`${name} (copy)`, ''),
        ...inheritParentFromSource,
      };

      const deselectChanges = allNodes
        .filter((n) => n.selected)
        .map((n) => ({ type: 'select' as const, id: n.id, selected: false }));
      if (deselectChanges.length > 0) dispatch(applyMixedEditorNodeChanges(deselectChanges));
      dispatch(appendMixedEditorNodes([newNode]));

      window.setTimeout(() => {
        updateNodeData(nid, { content: nextImageSrc });
      }, delayMs);
    },
    [dispatch, reduxStore, updateNodeData],
  );

  const createInpaintResultNodesRight = useCallback(
    (
      sourceNodeId: string,
      nextImageSrc: string,
      count: number,
      delayMs: number = 3000,
      resultImageSize?: { width: number; height: number },
    ) => {
      const allNodes = reduxStore.getState().mixedEditor.nodes ?? [];
      const source = allNodes.find((n) => n.id === sourceNodeId);
      if (!source) return;

      const deselectChanges = allNodes
        .filter((n) => n.selected)
        .map((n) => ({ type: 'select' as const, id: n.id, selected: false }));
      if (deselectChanges.length > 0) dispatch(applyMixedEditorNodeChanges(deselectChanges));

      const normalizedCount = Math.max(1, Math.floor(count));
      const data = source.data as ImageFlowNodeData;
      const name = data.name || 'Image';

      const sourceStyle = (source.style ?? {}) as { width?: number; height?: number };
      const copyW = typeof sourceStyle.width === 'number' ? sourceStyle.width : imageFlowDefaultWidth;
      const copyH = typeof sourceStyle.height === 'number' ? sourceStyle.height : imageFlowDefaultHeight;

      const nodeSize = nodeSizeFromResultOrFallback(resultImageSize, copyW, copyH);

      const startX = source.position.x + copyW + uploadGap;
      const startY = source.position.y;
      const resultIds: string[] = [];

      const inheritParentFromSource = inheritParentFieldsFromNode(source);

      if (normalizedCount === 1) {
        const nid = `image-flow-${nanoid(12)}`;
        resultIds.push(nid);
        const newNode: Node<ImageFlowNodeData> = {
          id: nid,
          type: imageEditorImageNodeType,
          position: { x: startX, y: startY },
          selected: true,
          style: { width: nodeSize.width, height: nodeSize.height },
          data: createEditorImageNodeData(`${name} (copy)`, ''),
          ...inheritParentFromSource,
        };
        dispatch(appendMixedEditorNodes([newNode]));
      } else {
        const groupPadding = 40;
        const spacingY = uploadGap;
        const childrenAbsolute = Array.from({ length: normalizedCount }, (_, index) => ({
          id: `image-flow-${nanoid(12)}`,
          x: startX,
          y: startY + index * (nodeSize.height + spacingY),
        }));
        const groupId = `group-${nanoid(8)}`;
        const minX = Math.min(...childrenAbsolute.map((n) => n.x));
        const minY = Math.min(...childrenAbsolute.map((n) => n.y));
        const maxX = Math.max(...childrenAbsolute.map((n) => n.x + nodeSize.width));
        const maxY = Math.max(...childrenAbsolute.map((n) => n.y + nodeSize.height));
        const groupLeft = minX - groupPadding;
        const groupTop = minY - groupPadding;
        const groupNode: Node = {
          id: groupId,
          type: 'group',
          position: { x: groupLeft, y: groupTop },
          style: {
            width: maxX - minX + groupPadding * 2,
            height: maxY - minY + groupPadding * 2,
            border: 0,
            boxShadow: 'none',
          },
          data: { collapsed: false, backgroundColor: 'rgba(12, 12, 13, 0.1)' },
          selected: true,
        };
        const childNodes: Node<ImageFlowNodeData>[] = childrenAbsolute.map((n, index) => {
          resultIds.push(n.id);
          return {
            id: n.id,
            type: imageEditorImageNodeType,
            parentId: groupId,
            position: { x: n.x - groupLeft, y: n.y - groupTop },
            selected: false,
            style: { width: nodeSize.width, height: nodeSize.height },
            data: createEditorImageNodeData(`${name} (copy ${index + 1})`, ''),
          };
        });
        dispatch(appendMixedEditorNodes([groupNode, ...childNodes]));
      }

      window.setTimeout(() => {
        resultIds.forEach((nodeId) => {
          updateNodeData(nodeId, { content: nextImageSrc });
        });
      }, delayMs);
    },
    [dispatch, reduxStore, updateNodeData],
  );

  const createEnhanceResultNodesRight = useCallback(
    (
      sourceNodeId: string,
      results: Array<{ row: number; col: number; src: string; width: number; height: number }>,
      delayMs: number = 3000,
    ) => {
      const allNodes = reduxStore.getState().mixedEditor.nodes ?? [];
      const source = allNodes.find((n) => n.id === sourceNodeId);
      if (!source || results.length === 0) return;

      const deselectChanges = allNodes
        .filter((n) => n.selected)
        .map((n) => ({ type: 'select' as const, id: n.id, selected: false }));
      if (deselectChanges.length > 0) dispatch(applyMixedEditorNodeChanges(deselectChanges));

      const data = source.data as ImageFlowNodeData;
      const name = data.name || 'Image';
      const sourceStyle = (source.style ?? {}) as { width?: number; height?: number };
      const copyW = typeof sourceStyle.width === 'number' ? sourceStyle.width : imageFlowDefaultWidth;
      const copyH = typeof sourceStyle.height === 'number' ? sourceStyle.height : imageFlowDefaultHeight;
      const gridGapX = 10;
      const gridGapY = 20;

      const startX = source.position.x + copyW + uploadGap;
      const startY = source.position.y;
      const minRow = Math.min(...results.map((item) => item.row));
      const minCol = Math.min(...results.map((item) => item.col));
      const sizedResults = results.map((item) => ({
        ...item,
        nodeSize: calcNodeSizeFromImage(item.width, item.height),
      }));
      const maxCellW = Math.max(...sizedResults.map((item) => item.nodeSize.width));
      const maxCellH = Math.max(...sizedResults.map((item) => item.nodeSize.height));
      const resultIds: string[] = [];

      if (sizedResults.length === 1) {
        const only = sizedResults[0];
        const nid = `image-flow-${nanoid(12)}`;
        resultIds.push(nid);
        dispatch(
          appendMixedEditorNodes([
            {
              id: nid,
              type: imageEditorImageNodeType,
              position: { x: startX, y: startY },
              selected: true,
              style: { width: only.nodeSize.width, height: only.nodeSize.height },
              data: createEditorImageNodeData(`${name} (enhance)`, ''),
            },
          ]),
        );
      } else {
        const groupPadding = 40;
        const minGroupGapX = 40;
        const maxRow = Math.max(...sizedResults.map((item) => item.row));
        const maxCol = Math.max(...sizedResults.map((item) => item.col));
        const contentWidth = (maxCol - minCol) * (maxCellW + gridGapX) + maxCellW;
        const contentHeight = (maxRow - minRow) * (maxCellH + gridGapY) + maxCellH;
        const groupWidth = contentWidth + groupPadding * 2;
        const groupHeight = contentHeight + groupPadding * 2;
        const sourceCenterY = source.position.y + copyH / 2;
        const groupLeft = source.position.x + copyW + minGroupGapX;
        const groupTop = sourceCenterY - groupHeight / 2;
        const groupId = `group-${nanoid(8)}`;
        const groupNode: Node = {
          id: groupId,
          type: 'group',
          position: { x: groupLeft, y: groupTop },
          style: {
            width: groupWidth,
            height: groupHeight,
            border: 0,
            boxShadow: 'none',
          },
          data: { collapsed: false, backgroundColor: 'rgba(12, 12, 13, 0.1)' },
          selected: true,
        };
        const childNodes: Node<ImageFlowNodeData>[] = sizedResults.map((item, index) => {
          const nodeId = `image-flow-${nanoid(12)}`;
          resultIds.push(nodeId);
          const cellColOffset = item.col - minCol;
          const cellRowOffset = item.row - minRow;
          const slotX = groupPadding + cellColOffset * (maxCellW + gridGapX);
          const slotY = groupPadding + cellRowOffset * (maxCellH + gridGapY);
          return {
            id: nodeId,
            type: imageEditorImageNodeType,
            parentId: groupId,
            position: { x: slotX, y: slotY },
            selected: false,
            style: { width: item.nodeSize.width, height: item.nodeSize.height },
            data: createEditorImageNodeData(`${name} (enhance ${index + 1})`, ''),
          };
        });
        dispatch(appendMixedEditorNodes([groupNode, ...childNodes]));
      }

      window.setTimeout(() => {
        resultIds.forEach((nodeId, index) => {
          const next = sizedResults[index];
          if (!next) return;
          updateNodeData(nodeId, { content: next.src });
        });
      }, delayMs);
    },
    [dispatch, reduxStore, updateNodeData],
  );

  const createCutVideoResultNodesRight = useCallback(
    (
      sourceNodeId: string,
      payload: { segments: Array<{ start: number; end: number }>; cutMarkers?: Array<{ id: string; progressPct: number }> },
      nextVideoSrc: string,
      delayMs: number = 1800,
    ) => {
      const allNodes = reduxStore.getState().mixedEditor.nodes ?? [];
      const source = allNodes.find((n) => n.id === sourceNodeId);
      if (!source || !nextVideoSrc) return;

      const normalizedSegments = payload.segments
        .map((segment) => ({
          start: Number.isFinite(segment.start) ? Math.max(0, segment.start) : 0,
          end: Number.isFinite(segment.end) ? Math.max(0, segment.end) : 0,
        }))
        .filter((segment) => segment.end - segment.start > 1e-3);
      if (normalizedSegments.length === 0) return;

      const deselectChanges = allNodes
        .filter((n) => n.selected)
        .map((n) => ({ type: 'select' as const, id: n.id, selected: false }));
      if (deselectChanges.length > 0) dispatch(applyMixedEditorNodeChanges(deselectChanges));

      const data = source.data as ImageFlowNodeData;
      const sourceName = typeof data?.name === 'string' && data.name.trim() ? data.name.trim() : 'video';
      const sourceStyle = (source.style ?? {}) as { width?: number; height?: number };
      const copyW = typeof sourceStyle.width === 'number' ? sourceStyle.width : imageFlowDefaultWidth;
      const copyH = typeof sourceStyle.height === 'number' ? sourceStyle.height : imageFlowDefaultHeight;
      const startX = source.position.x + copyW + uploadGap;
      const startY = source.position.y;
      const resultIds: string[] = [];

      if (normalizedSegments.length === 1) {
        const onlySegment = normalizedSegments[0];
        const nodeId = `video-flow-${nanoid(12)}`;
        resultIds.push(nodeId);
        dispatch(
          appendMixedEditorNodes([
            {
              id: nodeId,
              type: imageEditorVideoNodeType,
              position: { x: startX, y: startY },
              selected: true,
              style: { width: copyW, height: copyH },
              data: {
                ...createEditorVideoNodeData(`${sourceName} (clip 1)`, ''),
                nodeRuntimeData: {
                  parameter: {
                    cutMarkers: payload.cutMarkers ?? [],
                    cutSegments: normalizedSegments,
                    cutSegment: onlySegment,
                    cutSegmentIndex: 0,
                    cutSegmentCount: 1,
                    cutSourceNodeId: sourceNodeId,
                  },
                },
              },
            },
          ]),
        );
      } else {
        const spacingY = uploadGap;
        const groupPadding = 40;
        const minGroupGapX = 40;
        const groupWidth = copyW + groupPadding * 2;
        const contentHeight = normalizedSegments.length * copyH + (normalizedSegments.length - 1) * spacingY;
        const groupHeight = contentHeight + groupPadding * 2;
        const sourceCenterY = source.position.y + copyH / 2;
        const groupLeft = source.position.x + copyW + minGroupGapX;
        const groupTop = sourceCenterY - groupHeight / 2;
        const groupId = `group-${nanoid(8)}`;
        const groupNode: Node = {
          id: groupId,
          type: 'group',
          position: { x: groupLeft, y: groupTop },
          style: {
            width: groupWidth,
            height: groupHeight,
            border: 0,
            boxShadow: 'none',
          },
          data: { collapsed: false, backgroundColor: 'rgba(12, 12, 13, 0.1)' },
          selected: true,
        };
        const childNodes: Node<ImageFlowNodeData>[] = normalizedSegments.map((segment, index) => {
          const nodeId = `video-flow-${nanoid(12)}`;
          resultIds.push(nodeId);
          return {
            id: nodeId,
            type: imageEditorVideoNodeType,
            parentId: groupId,
            position: {
              x: groupPadding,
              y: groupPadding + index * (copyH + spacingY),
            },
            selected: false,
            style: { width: copyW, height: copyH },
            data: {
              ...createEditorVideoNodeData(`${sourceName} (clip ${index + 1})`, ''),
              nodeRuntimeData: {
                parameter: {
                  cutMarkers: payload.cutMarkers ?? [],
                  cutSegments: normalizedSegments,
                  cutSegment: segment,
                  cutSegmentIndex: index,
                  cutSegmentCount: normalizedSegments.length,
                  cutSourceNodeId: sourceNodeId,
                },
              },
            },
          };
        });
        dispatch(appendMixedEditorNodes([groupNode, ...childNodes]));
      }

      window.setTimeout(() => {
        resultIds.forEach((nodeId) => {
          updateNodeData(nodeId, { content: nextVideoSrc });
        });
      }, delayMs);
    },
    [dispatch, reduxStore, updateNodeData],
  );

  const importImagesFromFiles = useCallback(
    async (files: File[], options?: { viewportCenterFlow: { x: number; y: number } }) => {
      if (!files.length) return;

      const toDataUrl = (file: File) =>
        new Promise<string>((resolve) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result ?? ''));
          reader.readAsDataURL(file);
        });

      type Prepared = { file: File; src: string; nodeSize: { width: number; height: number } };
      const prepared: Prepared[] = [];
      for (const file of files) {
        const src = await toDataUrl(file);
        const meta = await getImageMeta(file);
        const nodeSize = calcNodeSizeFromImage(meta.width, meta.height);
        prepared.push({ file, src, nodeSize });
      }

      const created: Node<ImageFlowNodeData>[] = [];
      const center = options?.viewportCenterFlow;
      const currentNodes = reduxStore.getState().mixedEditor.nodes ?? [];
      const maxZIndex = currentNodes.reduce((max, n) => {
        const z = (n as Node & { zIndex?: number }).zIndex ?? 0;
        return Math.max(max, z);
      }, 0);
      let zIndexCursor = maxZIndex;

      if (center) {
        const totalH = prepared.reduce((h, item, i) => h + item.nodeSize.height + (i > 0 ? uploadGap : 0), 0);
        let y = center.y - totalH / 2;
        for (const { file, src, nodeSize } of prepared) {
          const nid = `image-flow-${nanoid(12)}`;
          zIndexCursor += 1;
          created.push({
            id: nid,
            type: imageEditorImageNodeType,
            position: { x: center.x - nodeSize.width / 2, y },
            selected: true,
            zIndex: zIndexCursor,
            style: { width: nodeSize.width, height: nodeSize.height },
            data: createEditorImageNodeData(file.name, src),
          });
          y += nodeSize.height + uploadGap;
        }
      } else {
        const list = currentNodes;
        let y = getNextStackY(list);
        for (const { file, src, nodeSize } of prepared) {
          const nid = `image-flow-${nanoid(12)}`;
          zIndexCursor += 1;
          created.push({
            id: nid,
            type: imageEditorImageNodeType,
            position: { x: 120, y },
            selected: true,
            zIndex: zIndexCursor,
            style: { width: nodeSize.width, height: nodeSize.height },
            data: createEditorImageNodeData(file.name, src),
          });
          y += nodeSize.height + uploadGap;
        }
      }

      const deselectChanges = currentNodes
        .filter((n) => n.selected)
        .map((n) => ({ type: 'select' as const, id: n.id, selected: false }));
      if (deselectChanges.length > 0) {
        dispatch(applyMixedEditorNodeChanges(deselectChanges));
      }

      dispatch(appendMixedEditorNodes(created));
    },
    [dispatch, reduxStore],
  );

  const importVideosFromFiles = useCallback(
    async (files: File[], options?: { viewportCenterFlow: { x: number; y: number } }) => {
      if (!files.length) return;

      const toDataUrl = (file: File) =>
        new Promise<string>((resolve) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result ?? ''));
          reader.readAsDataURL(file);
        });

      type Prepared = { file: File; src: string; nodeSize: { width: number; height: number } };
      const prepared: Prepared[] = [];
      for (const file of files) {
        const src = await toDataUrl(file);
        const meta = await getVideoMeta(file);
        const nodeSize = calcNodeSizeFromImage(meta.width, meta.height);
        prepared.push({ file, src, nodeSize });
      }

      const created: Node<ImageFlowNodeData>[] = [];
      const center = options?.viewportCenterFlow;
      const currentNodes = reduxStore.getState().mixedEditor.nodes ?? [];
      const maxZIndex = currentNodes.reduce((max, n) => {
        const z = (n as Node & { zIndex?: number }).zIndex ?? 0;
        return Math.max(max, z);
      }, 0);
      let zIndexCursor = maxZIndex;

      if (center) {
        const totalH = prepared.reduce((h, item, i) => h + item.nodeSize.height + (i > 0 ? uploadGap : 0), 0);
        let y = center.y - totalH / 2;
        for (const { file, src, nodeSize } of prepared) {
          const nid = `video-flow-${nanoid(12)}`;
          zIndexCursor += 1;
          created.push({
            id: nid,
            type: imageEditorVideoNodeType,
            position: { x: center.x - nodeSize.width / 2, y },
            selected: true,
            zIndex: zIndexCursor,
            style: { width: nodeSize.width, height: nodeSize.height },
            data: createEditorVideoNodeData(file.name || 'video', src),
          });
          y += nodeSize.height + uploadGap;
        }
      } else {
        const list = currentNodes;
        let y = getNextStackY(list);
        for (const { file, src, nodeSize } of prepared) {
          const nid = `video-flow-${nanoid(12)}`;
          zIndexCursor += 1;
          created.push({
            id: nid,
            type: imageEditorVideoNodeType,
            position: { x: 120, y },
            selected: true,
            zIndex: zIndexCursor,
            style: { width: nodeSize.width, height: nodeSize.height },
            data: createEditorVideoNodeData(file.name || 'video', src),
          });
          y += nodeSize.height + uploadGap;
        }
      }

      const deselectChanges = currentNodes
        .filter((n) => n.selected)
        .map((n) => ({ type: 'select' as const, id: n.id, selected: false }));
      if (deselectChanges.length > 0) {
        dispatch(applyMixedEditorNodeChanges(deselectChanges));
      }

      dispatch(appendMixedEditorNodes(created));
    },
    [dispatch, reduxStore],
  );

  const importAudiosFromFiles = useCallback(
    async (files: File[], options?: { viewportCenterFlow: { x: number; y: number } }) => {
      if (!files.length) return;

      const toDataUrl = (file: File) =>
        new Promise<string>((resolve) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result ?? ''));
          reader.readAsDataURL(file);
        });

      type Prepared = { file: File; src: string };
      const prepared: Prepared[] = [];
      for (const file of files) {
        const src = await toDataUrl(file);
        prepared.push({ file, src });
      }

      const created: Node<ImageFlowNodeData>[] = [];
      const center = options?.viewportCenterFlow;
      const currentNodes = reduxStore.getState().mixedEditor.nodes ?? [];
      const maxZIndex = currentNodes.reduce((max, n) => {
        const z = (n as Node & { zIndex?: number }).zIndex ?? 0;
        return Math.max(max, z);
      }, 0);
      let zIndexCursor = maxZIndex;

      if (center) {
        const totalH = prepared.length * audioFlowDefaultHeight + Math.max(0, prepared.length - 1) * uploadGap;
        let y = center.y - totalH / 2;
        for (const { file, src } of prepared) {
          const nid = `audio-flow-${nanoid(12)}`;
          zIndexCursor += 1;
          created.push({
            id: nid,
            type: imageEditorAudioNodeType,
            position: { x: center.x - audioFlowDefaultWidth / 2, y },
            selected: true,
            zIndex: zIndexCursor,
            style: { width: audioFlowDefaultWidth, height: audioFlowDefaultHeight },
            data: createEditorAudioNodeData(file.name || 'audio', src),
          });
          y += audioFlowDefaultHeight + uploadGap;
        }
      } else {
        let y = getNextStackY(currentNodes);
        for (const { file, src } of prepared) {
          const nid = `audio-flow-${nanoid(12)}`;
          zIndexCursor += 1;
          created.push({
            id: nid,
            type: imageEditorAudioNodeType,
            position: { x: 120, y },
            selected: true,
            zIndex: zIndexCursor,
            style: { width: audioFlowDefaultWidth, height: audioFlowDefaultHeight },
            data: createEditorAudioNodeData(file.name || 'audio', src),
          });
          y += audioFlowDefaultHeight + uploadGap;
        }
      }

      const deselectChanges = currentNodes
        .filter((n) => n.selected)
        .map((n) => ({ type: 'select' as const, id: n.id, selected: false }));
      if (deselectChanges.length > 0) {
        dispatch(applyMixedEditorNodeChanges(deselectChanges));
      }

      dispatch(appendMixedEditorNodes(created));
    },
    [dispatch, reduxStore],
  );

  const onNodesChange = useCallback(
    (changes: NodeChange[], options?: HistoryOptions) => {
      if (options?.history === 'skip') {
        requestNextYjsWriteOrigin(noHistoryOrigin);
      }
      dispatch(applyMixedEditorNodeChanges(changes));
    },
    [dispatch],
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      dispatch(applyMixedEditorEdgeChanges(changes));
    },
    [dispatch],
  );

  const onConnect = useCallback(
    (connection: Connection) => {
      dispatch(addMixedEditorEdge(connection));
    },
    [dispatch],
  );

  const setActiveTool = useCallback(
    (tool: EditorTool) => {
      dispatch(setMixedEditorActiveTool(tool as MixedEditorActiveTool));
    },
    [dispatch],
  );

  const setExpandViewportLock = useCallback(
    (nodeId: string, locked: boolean) => {
      dispatch(setMixedEditorExpandViewportLock({ nodeId, locked }));
    },
    [dispatch],
  );

  const toggleFavoriteAsset = useCallback(
    (payload: ToggleMixedEditorFavoritePayload) => {
      dispatch(toggleMixedEditorFavoriteAsset(payload));
    },
    [dispatch],
  );

  return {
    nodes,
    edges,
    activeTool,
    expandViewportLocked,
    favoriteAssets,
    setActiveTool,
    onNodesChange,
    onEdgesChange,
    onConnect,
    setNodes,
    updateNode,
    updateNodeData,
    setNodeDraggable,
    replaceNodeWithFile,
    removeNode,
    onCropNode,
    copyNodeImageSrc,
    createNewNodeBelow,
    createInpaintResultNodeRight,
    createInpaintResultNodesRight,
    createEnhanceResultNodesRight,
    createCutVideoResultNodesRight,
    importImagesFromFiles,
    importVideosFromFiles,
    importAudiosFromFiles,
    setExpandViewportLock,
    toggleFavoriteAsset,
  };
};
