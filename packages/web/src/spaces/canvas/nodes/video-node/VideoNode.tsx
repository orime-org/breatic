/**
 * Video input node (VideoNode)
 *
 * Asset content lands in `data.content` via either:
 *   - Left menu upload (F5 — `useUploadFiles` → permanent S3/OSS URL)
 *   - Mini-tool sibling (F4 — Worker writes via NodeStateUpdateEvent)
 *   - Generative downstream (F3 — Worker writes via NodeStateUpdateEvent)
 *
 * Per-node `customRequest` upload + Upload component + hidden file
 * input were removed in F5. Empty video nodes now show an
 * informational placeholder pointing the user at the left menu.
 */
import React, { useState, useEffect, memo } from 'react';
import { type NodeProps, Position, NodeToolbar as FlowNodeToolbar, useStore } from '@xyflow/react';
import { useTranslation } from 'react-i18next';
import NodeHeader from '@/spaces/canvas/common/NodeHeader';
import { Icon } from '@/ui/icon';
import VideoNodeContent from './VideoNodeContent';
import { useCanvasData } from '@/spaces/canvas/contexts/CanvasDataContext';
import { useCanvasActions } from '@/spaces/canvas/hooks/useCanvasActions';
import { useCanvasUI } from '@/spaces/canvas/contexts/CanvasUIContext';
import { useProjectLayout } from '@/app/contexts/ProjectLayoutContext';
import { cn } from '@/utils/classnames';
import VideoNodeToolbar from './NodeToolbar';
import DataNodeHandle from '@/spaces/canvas/common/DataNodeHandle';
import NodeSkeleton, { zoomLevelShowContentSelector } from '@/spaces/canvas/common/NodeSkeleton';

/** Edge handle IDs aligned with canvas conventions. */
const targetHandleId = 'Video_0_0';
const sourceHandleId = 'Video_0_0';

/** Default node size when empty; adapts to video aspect ratio when content exists. */
const defaultNodeWidth = 300;
const defaultNodeHeight = 250;

type VideoNodeData = { name?: string; content?: string; cover_url?: string; width?: number; height?: number; state?: string; errorMessage?: string };

const VideoNode: React.FC<NodeProps> = ({ id, selected, dragging }) => {
  const { t } = useTranslation();
  const { nodes } = useCanvasData();
  const { onNodesChange } = useCanvasActions();
  const { openRightPanel } = useProjectLayout();
  const { openCanvasOverlayPanel, closeCanvasOverlayPanel, canvasOverlayPanel } = useCanvasUI();
  const showContent = useStore(zoomLevelShowContentSelector);
  const [nodeHovered, setNodeHovered] = useState(false);
  /** Content area size derived from video ratio (same rule as ImageNode). */
  const [contentHeight, setContentHeight] = useState<number | null>(null);
  const [contentWidth, setContentWidth] = useState<number | null>(null);

  /** Derived from node data: current video URL from data.content (canvas-native schema). */
  const currentNode = nodes.find((n: { id: string }) => n.id === id);
  const nodeData = currentNode?.data as VideoNodeData | undefined;
  /** Direct read: cover_url for thumbnail, content for playback URL. */
  const videoUrlFromData = nodeData?.content ?? '';
  const isHandling = nodeData?.state === 'handling';
  const errorMessage = nodeData?.errorMessage;
  const [videoUrl, setVideoUrl] = useState(videoUrlFromData);

  /** Sync local state from data.content and dimensions. */
  useEffect(() => {
    if (videoUrlFromData !== videoUrl) {
      setVideoUrl(videoUrlFromData);
    }
    // Clear content size when empty; fallback to default node size.
    if (!videoUrlFromData) {
      setContentHeight(null);
      setContentWidth(null);
    }
    const w = nodeData?.width;
    const h = nodeData?.height;
    if (videoUrlFromData && typeof w === 'number' && typeof h === 'number' && w > 0 && h > 0) {
      const isLandscape = w >= h;
      if (isLandscape) {
        const contentH = Math.max(Math.round(defaultNodeWidth * (h / w)), defaultNodeHeight);
        setContentHeight(contentH);
        setContentWidth(Math.round(contentH * (w / h)));
      } else {
        setContentWidth(defaultNodeWidth);
        setContentHeight(Math.round(defaultNodeWidth * (h / w)));
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoUrlFromData, nodeData?.width, nodeData?.height]);

  const handleMentionClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    openRightPanel('editor', id);
  };

  const selectedCount = nodes.filter((n: { selected?: boolean }) => n.selected).length;
  const parentNode = currentNode?.parentId ? nodes.find((n) => n.id === currentNode.parentId) : null;
  const isInsideLockedGroup =
    parentNode?.type === 'group' && (parentNode.data as { locked?: boolean })?.locked === true;
  const showToolbar = selected && selectedCount === 1 && !dragging && !isInsideLockedGroup;

  const handleToolbarInfoClick = () => {
    const isCurrentNodePanelOpen = canvasOverlayPanel.open && canvasOverlayPanel.nodeId === id;
    if (isCurrentNodePanelOpen) {
      closeCanvasOverlayPanel();
      return;
    }
    openCanvasOverlayPanel(id);
  };

  /** Placeholder click: stop propagation and select current node. */
  const handlePlaceholderClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    onNodesChange(nodes.map((n: { id: string }) => ({ type: 'select' as const, id: n.id, selected: n.id === id })));
  };

  return (
    <>
      <FlowNodeToolbar position={Position.Top} align='center' offset={40} isVisible={showToolbar}>
        <div className='rounded-[8px] pointer-events-auto' onMouseDown={(e) => e.stopPropagation()}>
          <VideoNodeToolbar
            nodeId={id}
            onShootVideoClick={handleToolbarInfoClick}
          />
        </div>
      </FlowNodeToolbar>
      <div
        className='relative w-0 min-w-0'
        style={{
          width: videoUrl ? (contentWidth ?? defaultNodeWidth) : defaultNodeWidth,
          height: videoUrl ? (contentHeight ?? defaultNodeHeight) : defaultNodeHeight,
        }}
      >
        <div className='absolute -translate-y-full text-left left-0 -top-0 text-foreground/60 overflow-hidden text-ellipsis whitespace-nowrap'>
          <NodeHeader nodeId={id} title={t('project.panel.videos')} editable={true} />
        </div>
        <div
          className={
            'relative flex min-h-0 flex-col rounded-[8px] bg-background-default-base outline outline-2 pointer-events-auto ' +
            (selected ? 'outline-solid outline-border-utilities-selected' : 'outline-transparent')
          }
          style={{
            width: videoUrl ? (contentWidth ?? defaultNodeWidth) : defaultNodeWidth,
            height: videoUrl ? (contentHeight ?? defaultNodeHeight) : defaultNodeHeight,
          }}
          onMouseEnter={() => setNodeHovered(true)}
          onMouseLeave={() => setNodeHovered(false)}
        >
          <DataNodeHandle
            type='target'
            position={Position.Left}
            handleId={targetHandleId}
            nodeId={id}
            selected={selected}
            nodeHovered={nodeHovered}
            isInsideLockedGroup={isInsideLockedGroup}
          />
          <DataNodeHandle
            type='source'
            position={Position.Right}
            handleId={sourceHandleId}
            nodeId={id}
            selected={selected}
            nodeHovered={nodeHovered}
            isInsideLockedGroup={isInsideLockedGroup}
          />
          <div className='flex-1 min-h-0'>
            {!showContent ? (
              <NodeSkeleton />
            ) : (
              <div className={cn(
                'w-full h-full min-h-0 flex items-center justify-center overflow-hidden rounded-[8px]',
                errorMessage && !isHandling && 'outline outline-2 outline-red-400',
              )}>
                {videoUrl ? (
                  <div className='relative w-full h-full'>
                    {/* Handling overlay */}
                    {isHandling && (
                      <div className='absolute inset-0 z-[10] flex flex-col items-center justify-center rounded-[8px] bg-black/40 pointer-events-none'>
                        <Icon name='base-loading-spinner' width={28} height={28} className='animate-spin text-white' />
                        <div className='text-[12px] text-white font-normal mt-2'>{t('canvas.node.processing', 'Processing...')}</div>
                      </div>
                    )}
                    {errorMessage && !isHandling && (
                      <div className='absolute top-1 right-1 z-[10] max-w-[80%] rounded px-1.5 py-0.5 text-[10px] font-medium text-white bg-red-500 leading-tight truncate' title={errorMessage}>
                        {errorMessage}
                      </div>
                    )}
                    <VideoNodeContent src={videoUrl} selected={selected} onMentionClick={handleMentionClick} />
                  </div>
                ) : isHandling ? (
                  <div className='w-full h-full flex flex-col items-center justify-center text-center'>
                    <Icon name='base-loading-spinner' width={32} height={32} className='animate-spin' />
                    <div className='text-[12px] text-text-default-tertiary font-normal mt-2'>{t('canvas.node.processing', 'Processing...')}</div>
                  </div>
                ) : (
                  <div
                    className='w-full h-full flex flex-col items-center justify-center cursor-default gap-2'
                    onClick={handlePlaceholderClick}
                  >
                    <Icon
                      name='project-video-node-placeholder'
                      width={48}
                      height={48}
                      className='text-text-default-tertiary'
                    />
                    <div className='text-center text-[12px] font-normal text-text-default-tertiary'>
                      {t('canvas.node.video.emptyHint', '点左侧菜单"上传"添加素材')}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
};

export default memo(VideoNode);
