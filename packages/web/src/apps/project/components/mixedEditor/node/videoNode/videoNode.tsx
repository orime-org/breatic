import React, { memo, useCallback, useMemo, useRef, useState } from 'react';
import { NodeResizer, NodeToolbar as FlowNodeToolbar, Position, useReactFlow, type Node, type NodeProps } from '@xyflow/react';
import { nanoid } from 'nanoid';
import Loading from '@/components/loading';
import Video, { type VideoPlaybackSnapshot, type VideoRef } from '@/apps/project/components/canvas/common/Video';
import { useMixedEditorStore } from '@/hooks/useMixedEditorStore';
import { useCanvasData } from '@/contexts/CanvasDataContext';
import { useCanvasActions } from '@/hooks/useCanvasActions';
import { getVideoMetaFromUrl } from '@/utils/mediaUtils';
import { cutVideoWithFfmpeg } from '@/utils/videoCutWithFfmpeg';
import { speedVideoWithFfmpeg } from '@/utils/videoSpeedWithFfmpeg';
import { type CanvasWorkflowNodeData, getProjectCanvasViewportApi } from '@/apps/project/components/canvas/types';
import NodeHeader from '../../common/NodeHeader';
import type { ImageFlowNodeData } from '../../types';
import { imageEditorVideoNodeType } from '../../types';
import Toolbar from './Toolbar';
import PlaybackPanel from './playback/PlaybackPanel';
import BottomToolbar from './BottomToolbar';
import CutBottomToolbar from './cut/CutBottomToolbar';
import SpeedBottomToolbar from './speed/SpeedBottomToolbar';
import type { TimelineCutMarker } from './playback/PlaybackPanel';

const videoFlowMinWidth = 120;
const videoFlowMinHeight = 80;

const canvasWorkflowVideoNodeType = '1003';
const canvasVideoNodeFallbackWidth = 300;
const canvasVideoNodeFallbackHeight = 250;
const newCanvasVideoGap = 40;
const workflowCanvasVideoDefaultWidth = 300;
const workflowCanvasVideoDefaultHeight = 250;

function computeWorkflowCanvasVideoDisplaySize(
  naturalWidth: number,
  naturalHeight: number,
): { width: number; height: number } {
  if (naturalWidth <= 0 || naturalHeight <= 0) {
    return { width: workflowCanvasVideoDefaultWidth, height: workflowCanvasVideoDefaultHeight };
  }
  const isLandscape = naturalWidth >= naturalHeight;
  if (isLandscape) {
    const h = Math.max(
      Math.round(workflowCanvasVideoDefaultWidth * (naturalHeight / naturalWidth)),
      workflowCanvasVideoDefaultHeight,
    );
    const w = Math.round(h * (naturalWidth / naturalHeight));
    return { width: w, height: h };
  }
  return {
    width: workflowCanvasVideoDefaultWidth,
    height: Math.round(workflowCanvasVideoDefaultWidth * (naturalHeight / naturalWidth)),
  };
}

function projectCanvasNodeBounds(n: Node): { left: number; top: number; right: number; bottom: number } {
  const st = (n.style ?? {}) as { width?: number; height?: number };
  const w = typeof st.width === 'number' ? st.width : canvasVideoNodeFallbackWidth;
  const h = typeof st.height === 'number' ? st.height : canvasVideoNodeFallbackHeight;
  return {
    left: n.position.x,
    top: n.position.y,
    right: n.position.x + w,
    bottom: n.position.y + h,
  };
}

function suggestNewProjectCanvasVideoPosition(canvasNodes: Node[]): { x: number; y: number } {
  if (canvasNodes.length === 0) return { x: 120, y: 80 };

  const selected = canvasNodes.filter((n) => n.selected);
  const focusNodes = selected.length > 0 ? selected : canvasNodes;

  let minTop = Infinity;
  let maxRight = -Infinity;
  for (const n of focusNodes) {
    const b = projectCanvasNodeBounds(n);
    minTop = Math.min(minTop, b.top);
    maxRight = Math.max(maxRight, b.right);
  }

  if (selected.length > 0) {
    return { x: maxRight + newCanvasVideoGap, y: minTop };
  }

  let globalMaxRight = -Infinity;
  let globalY = 80;
  for (const n of canvasNodes) {
    const b = projectCanvasNodeBounds(n);
    if (b.right > globalMaxRight) {
      globalMaxRight = b.right;
      globalY = b.top;
    }
  }
  return { x: globalMaxRight + newCanvasVideoGap, y: globalY };
}

function createProjectCanvasVideoNodeFromEditor(params: {
  content: string;
  name: string;
  position: { x: number; y: number };
  width: number;
  height: number;
  zIndex: number;
}): Node {
  const newId = `${canvasWorkflowVideoNodeType}-${Date.now()}-${nanoid(5)}`;
  return {
    id: newId,
    type: canvasWorkflowVideoNodeType,
    position: params.position,
    selected: true,
    zIndex: params.zIndex,
    style: { width: params.width, height: params.height },
    data: {
      name: params.name,
      content: params.content,
      state: 'idle',
      handles: {
        target: [{ handleType: 'Video', number: 0 }],
        source: [{ handleType: 'Video', number: 0 }],
      },
    } satisfies CanvasWorkflowNodeData,
  };
}

function getTrimmedVideoFlowNodeName(data: ImageFlowNodeData, fallback = 'video'): string {
  const raw = data.name;
  return typeof raw === 'string' && raw.trim() ? raw.trim() : fallback;
}

function shouldShowVideoFlowToolbars(params: {
  selected: boolean;
  selectedVideoFlowNodeCount: number;
  dragging: boolean;
  isEditing: boolean;
  hasVideoContent: boolean;
}): boolean {
  return (
    params.selected &&
    params.selectedVideoFlowNodeCount === 1 &&
    !params.dragging &&
    !params.isEditing &&
    params.hasVideoContent
  );
}

const VideoNode: React.FC<NodeProps> = ({ id, data, selected, dragging, width, height }) => {
  const { setCenter } = useReactFlow();
  const { createCutVideoResultNodesRight, createVideoPlaceholderNodeRight, resolveVideoResultNode, removeNode, updateNodeData, nodes } = useMixedEditorStore();
  const { nodes: projectCanvasNodes } = useCanvasData();
  const { updateNode: updateProjectCanvasNode, addNode: addProjectCanvasNode } = useCanvasActions();
  const nodeData = data as ImageFlowNodeData | undefined;
  const videoContent = String(nodeData?.content ?? '');
  const title = nodeData?.name?.trim() || 'video';
  const currentWidth = Math.max(1, Math.round(width ?? videoFlowMinWidth));
  const currentHeight = Math.max(1, Math.round(height ?? videoFlowMinHeight));
  const resolutionText = `${currentWidth}x${currentHeight}`;

  const nodeFrameRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<VideoRef | null>(null);
  const [playback, setPlayback] = useState<VideoPlaybackSnapshot>({
    currentTime: 0,
    duration: 0,
    isPlaying: false,
    volume: 1,
  });
  const [editingMode, setEditingMode] = useState<'cut' | 'speed' | null>(null);
  const [isCutSaving, setIsCutSaving] = useState(false);
  const [isSpeedSaving, setIsSpeedSaving] = useState(false);
  const nodeFromStore = useMemo(() => nodes.find((n: Node) => n.id === id), [nodes, id]);

  const handlePlaybackUpdate = useCallback((snapshot: VideoPlaybackSnapshot) => {
    setPlayback(snapshot);
  }, []);

  const selectedVideoCount = useMemo(
    () => nodes.filter((n: Node) => n.selected && n.type === imageEditorVideoNodeType).length,
    [nodes],
  );

  const hasProjectCanvasVideoSelection = useMemo(
    () => projectCanvasNodes.some((n) => n.selected && n.type === canvasWorkflowVideoNodeType),
    [projectCanvasNodes],
  );

  const showToolbars = shouldShowVideoFlowToolbars({
    selected,
    selectedVideoFlowNodeCount: selectedVideoCount,
    dragging,
    isEditing: editingMode !== null,
    hasVideoContent: Boolean(videoContent),
  });

  const syncPlaybackFromVideo = selected && Boolean(videoContent);

  const focusCurrentNode = useCallback(
    (zoom = 1) => {
      const p = nodeFromStore?.position;
      if (!p) return;
      setCenter(p.x + currentWidth / 2, p.y + currentHeight / 2, { zoom, duration: 220 });
    },
    [currentHeight, currentWidth, nodeFromStore?.position, setCenter],
  );

  const handleCutOpen = useCallback(() => {
    if (!videoContent || editingMode === 'cut') return;
    focusCurrentNode();
    setEditingMode('cut');
  }, [editingMode, focusCurrentNode, videoContent]);

  const handleSpeedOpen = useCallback(() => {
    if (!videoContent || editingMode === 'speed') return;
    focusCurrentNode();
    setEditingMode('speed');
  }, [editingMode, focusCurrentNode, videoContent]);

  const handleCutClose = useCallback(() => {
    if (editingMode !== 'cut') return;
    setEditingMode(null);
  }, [editingMode]);

  const handleSpeedClose = useCallback(() => {
    if (editingMode !== 'speed') return;
    setEditingMode(null);
  }, [editingMode]);

  const handleCutSave = useCallback(
    async (payload: { cutMarkers: TimelineCutMarker[]; segments: Array<{ start: number; end: number }> }) => {
      if (!videoContent || isCutSaving) return;
      setIsCutSaving(true);
      try {
        const clipSources = await cutVideoWithFfmpeg(videoContent, payload.segments);
        if (clipSources.length === 0) return;
        createCutVideoResultNodesRight(id, payload, clipSources, 200);
        setEditingMode(null);
      } catch {
        return;
      } finally {
        setIsCutSaving(false);
      }
    },
    [createCutVideoResultNodesRight, id, isCutSaving, videoContent],
  );

  const handleSpeedSave = useCallback(
    async (payload: { playbackRate: number }) => {
      if (!videoContent || isSpeedSaving) return;
      const placeholderId = createVideoPlaceholderNodeRight(id, { nameSuffix: 'speed', state: 'generating' });
      if (!placeholderId) return;
      setEditingMode(null);
      setIsSpeedSaving(true);
      try {
        const speedSrc = await speedVideoWithFfmpeg(videoContent, payload.playbackRate);
        if (!speedSrc) {
          removeNode(placeholderId);
          return;
        }
        resolveVideoResultNode(placeholderId, speedSrc, { state: 'idle' });
      } catch {
        removeNode(placeholderId);
        return;
      } finally {
        setIsSpeedSaving(false);
      }
    },
    [createVideoPlaceholderNodeRight, id, isSpeedSaving, removeNode, resolveVideoResultNode, videoContent],
  );

  const handleCreateNewCanvasVideoNode = useCallback(() => {
    if (!videoContent) return;
    void (async () => {
      let displayW = Math.max(1, Math.round(currentWidth));
      let displayH = Math.max(1, Math.round(currentHeight));
      try {
        const meta = await getVideoMetaFromUrl(videoContent);
        const nw = meta.width ?? 0;
        const nh = meta.height ?? 0;
        if (nw > 0 && nh > 0) {
          const d = computeWorkflowCanvasVideoDisplaySize(nw, nh);
          displayW = d.width;
          displayH = d.height;
        }
      } catch {
        // decode / CORS: keep editor tile size
      }
      const viewportApi = getProjectCanvasViewportApi();
      const center = viewportApi?.getViewportCenterFlow();
      const position =
        center != null
          ? { x: center.x - displayW / 2, y: center.y - displayH / 2 }
          : suggestNewProjectCanvasVideoPosition(projectCanvasNodes);
      const maxZ = projectCanvasNodes.reduce(
        (m, n) => Math.max(m, (n as Node & { zIndex?: number }).zIndex ?? 0),
        0,
      );
      const newNode = createProjectCanvasVideoNodeFromEditor({
        content: videoContent,
        name: getTrimmedVideoFlowNodeName(nodeData ?? { name: title, content: '', state: 'idle', nodeRuntimeData: {} }),
        position,
        width: displayW,
        height: displayH,
        zIndex: maxZ + 1,
      });
      addProjectCanvasNode(newNode, { select: true });
    })();
  }, [addProjectCanvasNode, currentHeight, currentWidth, nodeData, projectCanvasNodes, title, videoContent]);

  const handleAddToNodeClick = () => {
    if (!videoContent || !hasProjectCanvasVideoSelection) return;
    const targets = projectCanvasNodes.filter(
      (n) => n.selected && n.type === canvasWorkflowVideoNodeType,
    );
    const sourceName = getTrimmedVideoFlowNodeName(nodeData ?? { name: title, content: '', state: 'idle', nodeRuntimeData: {} });
    for (const target of targets) {
      updateProjectCanvasNode(target.id, {
        data: {
          content: videoContent,
          name: sourceName,
          state: 'idle',
          nodeSelectedResultData: null,
          pickState: null,
        } as Partial<CanvasWorkflowNodeData>,
      });
    }
  };

  return (
    <>
      <FlowNodeToolbar isVisible={showToolbars} position={Position.Top} offset={50} align='center'>
        <Toolbar nodeId={id} onCut={handleCutOpen} onSpeed={handleSpeedOpen} />
      </FlowNodeToolbar>
      <FlowNodeToolbar isVisible={showToolbars} position={Position.Bottom} offset={12} align='center'>
        <div className='flex flex-col items-center gap-1' onMouseDown={(e) => e.stopPropagation()}>
          <PlaybackPanel
            videoRef={videoRef}
            mediaSrc={videoContent}
            currentTime={playback.currentTime}
            duration={playback.duration}
            isPlaying={playback.isPlaying}
            volume={playback.volume}
            fullscreenTargetRef={nodeFrameRef}
          />
          <BottomToolbar
            videoSrc={videoContent}
            onAddToNodeClick={handleAddToNodeClick}
            onCreateNewNodeClick={handleCreateNewCanvasVideoNode}
            disableAddToNode={!videoContent || !hasProjectCanvasVideoSelection}
            disableCreateNewNode={!videoContent}
            disableDownload={!videoContent}
          />
        </div>
      </FlowNodeToolbar>
      <FlowNodeToolbar isVisible={editingMode === 'cut'} position={Position.Bottom} offset={12} align='center'>
        <CutBottomToolbar
          active={editingMode === 'cut'}
          videoRef={videoRef}
          mediaSrc={videoContent}
          currentTime={playback.currentTime}
          duration={playback.duration}
          isPlaying={playback.isPlaying}
          volume={playback.volume}
          fullscreenTargetRef={nodeFrameRef}
          isSaving={isCutSaving}
          onClose={handleCutClose}
          onSave={handleCutSave}
        />
      </FlowNodeToolbar>
      <FlowNodeToolbar isVisible={editingMode === 'speed'} position={Position.Bottom} offset={12} align='center'>
        <SpeedBottomToolbar
          active={editingMode === 'speed'}
          videoRef={videoRef}
          mediaSrc={videoContent}
          currentTime={playback.currentTime}
          duration={playback.duration}
          isPlaying={playback.isPlaying}
          volume={playback.volume}
          fullscreenTargetRef={nodeFrameRef}
          isSaving={isSpeedSaving}
          onClose={handleSpeedClose}
          onSave={handleSpeedSave}
        />
      </FlowNodeToolbar>
      <div
        ref={nodeFrameRef}
        className='relative h-full w-full min-w-0'
        style={{ minWidth: videoFlowMinWidth, minHeight: videoFlowMinHeight }}
      >
        <div className='absolute -translate-y-full left-0 right-0 -top-0 overflow-hidden'>
          <NodeHeader
            title={title}
            resolutionText={resolutionText}
            editable
            onTitleChange={(value) => updateNodeData(id, { name: value })}
          />
        </div>
        <NodeResizer
          isVisible={selected && editingMode === null}
          keepAspectRatio
          minWidth={videoFlowMinWidth}
          minHeight={videoFlowMinHeight}
        />
        <div
          className='relative flex h-full min-h-0 flex-col bg-background-default-base outline outline-2 pointer-events-auto'
          style={{ outlineColor: selected ? 'var(--color-border-utilities-selected)' : 'transparent' }}
        >
          <div className='relative h-full w-full min-h-0 overflow-hidden bg-white shadow-sm'>
            {videoContent ? (
              <Video
                ref={videoRef}
                src={videoContent}
                showControlBar={false}
                onPlaybackUpdate={syncPlaybackFromVideo ? handlePlaybackUpdate : undefined}
                className='h-full w-full !rounded-none'
              />
            ) : (
              <Loading inline backgroundColor='#ffffff' width='100%' height='100%' />
            )}
          </div>
        </div>
      </div>
    </>
  );
};

export default memo(VideoNode);
