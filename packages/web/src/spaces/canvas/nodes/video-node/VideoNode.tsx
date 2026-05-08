/**
 * Video input node (VideoNode)
 * - Supports video upload and video URL input (mp4/mov)
 * - Shows NodeToolbar on selection
 * - Local preview via blob URL after upload
 */
import React, { useState, useEffect, memo, useRef } from 'react';
import { type NodeProps, Position, NodeToolbar as FlowNodeToolbar, useStore } from '@xyflow/react';
import { Upload } from '@/ui/upload';
import { message } from '@/ui/message';
import { useTranslation } from 'react-i18next';
import NodeHeader from '../../common/NodeHeader';
import { Icon } from '@/ui/icon';
import VideoNodeContent from './VideoNodeContent';
import { useCanvasData } from '@/spaces/canvas/contexts/CanvasDataContext';
import { useCanvasActions } from '@/spaces/canvas/hooks/useCanvasActions';
import { useCanvasUI } from '@/spaces/canvas/contexts/CanvasUIContext';
import { useProjectLayout } from '@/app/contexts/ProjectLayoutContext';
import { cn } from '@/utils/classnames';
import { getVideoMeta } from '@/utils/mediaUtils';
import {
  shouldHideNodeChatComposerForChatRecordCanvasPick,
  type CanvasWorkflowNodeData,
} from '@/spaces/canvas/types';
import VideoNodeToolbar from './NodeToolbar';
import DataNodeHandle from '../../common/DataNodeHandle';
import NodeSkeleton, { zoomLevelShowContentSelector } from '../../common/NodeSkeleton';
import NodeChatComposer from '@/features/chat/components/NodeChatComposer';

/** Edge handle IDs aligned with canvas conventions. */
const targetHandleId = 'Video_0_0';
const sourceHandleId = 'Video_0_0';

/** Default node size when empty; adapts to video aspect ratio when content exists. */
const defaultNodeWidth = 300;
const defaultNodeHeight = 250;

type VideoNodeData = { name?: string; content?: string; cover_url?: string; width?: number; height?: number; state?: string; errorMessage?: string; pickState?: CanvasWorkflowNodeData['pickState'] };

const VideoNode: React.FC<NodeProps> = ({ id, selected, dragging }) => {
  const { t } = useTranslation();
  const { nodes } = useCanvasData();
  const { setNodeContent, onNodesChange } = useCanvasActions();
  const { openRightPanel } = useProjectLayout();
  const { openCanvasOverlayPanel, closeCanvasOverlayPanel, canvasOverlayPanel } = useCanvasUI();
  const showContent = useStore(zoomLevelShowContentSelector);
  const [nodeHovered, setNodeHovered] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const uploadInputRef = useRef<HTMLInputElement>(null);
  /** Content area size derived from video ratio (same rule as ImageNode). */
  const [contentHeight, setContentHeight] = useState<number | null>(null);
  const [contentWidth, setContentWidth] = useState<number | null>(null);

  /** Derived from node data: current video URL from data.content (canvas-native schema). */
  const currentNode = nodes.find((n: { id: string }) => n.id === id);
  const nodeData = currentNode?.data as VideoNodeData | undefined;
  const wf = nodeData as Partial<CanvasWorkflowNodeData> | undefined;
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

  /** Compute content area size from source dimensions (same as ImageNode). */
  const applyContentSizeFromDimensions = (naturalWidth: number, naturalHeight: number) => {
    if (naturalWidth <= 0) return;
    const isLandscape = naturalWidth >= naturalHeight;
    if (isLandscape) {
      const h = Math.max(Math.round(defaultNodeWidth * (naturalHeight / naturalWidth)), defaultNodeHeight);
      setContentHeight(h);
      setContentWidth(Math.round(h * (naturalWidth / naturalHeight)));
    } else {
      setContentWidth(defaultNodeWidth);
      setContentHeight(Math.round(defaultNodeWidth * (naturalHeight / naturalWidth)));
    }
  };

  /** Local file: object URL — writes content directly to node data (canvas-native schema). */
  const customRequest = async (options: {
    file: File;
    onSuccess: (response: unknown) => void;
    onError: (error: Error) => void;
  }) => {
    const { file, onSuccess, onError } = options;
    setIsLoading(true);
    try {
      const meta = await getVideoMeta(file);
      if (meta.width != null && meta.height != null) {
        applyContentSizeFromDimensions(meta.width, meta.height);
      }
      const resourceUrl = URL.createObjectURL(file);
      setNodeContent(id, {
        content: resourceUrl,
        width: meta.width ?? undefined,
        height: meta.height ?? undefined,
      });
      setIsLoading(false);
      onSuccess(resourceUrl);
    } catch (error) {
      console.error('Upload failed:', error);
      message.warning('Video upload failed');
      setIsLoading(false);
      onError(error as Error);
    }
  };

  // TODO: replaced by presigned URL upload hook

  const handleMentionClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    openRightPanel('editor', id);
  };

  const selectedCount = nodes.filter((n: { selected?: boolean }) => n.selected).length;
  const parentNode = currentNode?.parentId ? nodes.find((n) => n.id === currentNode.parentId) : null;
  const isInsideLockedGroup =
    parentNode?.type === 'group' && (parentNode.data as { locked?: boolean })?.locked === true;
  const showToolbar = selected && selectedCount === 1 && !dragging && !isInsideLockedGroup;
  const showBottomNodeChatComposer = showToolbar && !shouldHideNodeChatComposerForChatRecordCanvasPick(wf);

  /** Toolbar Upload: trigger the same upload flow as node content area. */
  const handleToolbarUploadClick = () => {
    uploadInputRef.current?.click();
  };

  const handleToolbarInfoClick = () => {
    const isCurrentNodePanelOpen = canvasOverlayPanel.open && canvasOverlayPanel.nodeId === id;
    if (isCurrentNodePanelOpen) {
      closeCanvasOverlayPanel();
      return;
    }
    openCanvasOverlayPanel(id);
  };

  const handleToolbarFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    customRequest({
      file,
      onSuccess: () => {},
      onError: () => {},
    });
  };

  /** Placeholder click: stop propagation and select current node. */
  const handlePlaceholderClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    onNodesChange(nodes.map((n: { id: string }) => ({ type: 'select' as const, id: n.id, selected: n.id === id })));
  };

  const handleChatInputSend = (content: string, imageUrls?: string[]) => {
    // eslint-disable-next-line no-console
    console.log('VideoNode ChatInput send:', { nodeId: id, content, imageUrls });
    // TODO: Wire to the ChatMessage list bound to this node.
  };

  return (
    <>
      <input
        ref={uploadInputRef}
        type='file'
        accept='.mp4,.mov'
        className='hidden'
        onChange={handleToolbarFileChange}
      />
      <FlowNodeToolbar position={Position.Top} align='center' offset={40} isVisible={showToolbar}>
        <div className='rounded-[8px] pointer-events-auto' onMouseDown={(e) => e.stopPropagation()}>
          <VideoNodeToolbar
            nodeId={id}
            isUploading={isLoading}
            onUploadClick={handleToolbarUploadClick}
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
            ) : isLoading ? (
              <div className='w-full h-full flex flex-col items-center justify-center text-center'>
                <Icon name='base-loading-spinner' width={32} height={32} className='animate-spin' />
                <div className='text-[12px] text-text-default-tertiary font-normal mt-2'>Loading Video...</div>
              </div>
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
                        <div className='text-[12px] text-white font-normal mt-2'>Processing...</div>
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
                    <div className='text-[12px] text-text-default-tertiary font-normal mt-2'>Processing...</div>
                  </div>
                ) : (
                  <Upload
                    customRequest={customRequest}
                    showUploadList={false}
                    accept='.mp4,.mov'
                    className='w-full h-full'
                  >
                    <div
                      className='w-full h-full flex flex-col items-center justify-center cursor-pointer gap-2 h-full'
                      onClick={handlePlaceholderClick}
                      onDoubleClick={(e) => {
                        e.stopPropagation();
                        uploadInputRef.current?.click();
                      }}
                    >
                      <Icon
                        name='project-video-node-placeholder'
                        width={48}
                        height={48}
                        className='text-text-default-tertiary'
                      />
                      <div className='text-center text-[12px] font-normal text-text-default-tertiary'>
                        {t('project.toolbar.videoNodePlaceholder')
                          .split('\n')
                          .map((line, i) => (
                            <div key={i}>{line}</div>
                          ))}
                      </div>
                    </div>
                  </Upload>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
      {/* Bottom FlowNodeToolbar: show a floating ChatInput below when selected. */}
      <FlowNodeToolbar position={Position.Bottom} align='center' offset={20} isVisible={showBottomNodeChatComposer}>
        <NodeChatComposer
          className='w-[526px] min-h-[160px] pointer-events-auto rounded-[16px]'
          onSend={handleChatInputSend}
          targetNodeId={id}
        />
      </FlowNodeToolbar>
    </>
  );
};

export default memo(VideoNode);
