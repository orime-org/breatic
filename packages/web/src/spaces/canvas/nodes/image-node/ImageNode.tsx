/**
 * Image input node (ImageNode)
 *
 * Asset content lands in `data.content` via either:
 *   - Left menu upload (F5 — `useUploadFiles` → permanent S3/OSS URL)
 *   - Mini-tool sibling (F4 — Worker writes via NodeStateUpdateEvent)
 *   - Generative downstream (F3 — Worker writes via NodeStateUpdateEvent)
 *
 * v12 cleanup (B.2): removed the per-node `NodeChatComposer` bottom
 * toolbar, the `pickState`-driven canvas-pick-into-editor recognition
 * pills + `RecognizedPickDropdown` overlays. v13 model is
 * session-based chat in the left `ChatPanel` with chips referencing
 * canvas nodes through `ChipsPickContext` (B.1) — no per-node chat
 * composer, no Yjs-backed pick state.
 */
import React, { useState, useEffect, memo } from 'react';
import { type NodeProps, Position, NodeToolbar as FlowNodeToolbar, useStore } from '@xyflow/react';
import { message } from '@/ui/message';
import { useTranslation } from 'react-i18next';
import NodeHeader from '../../common/NodeHeader';
import ImageNodeContent from './ImageNodeContent';
import { Icon } from '@/ui/icon';
import { useCanvasData } from '@/spaces/canvas/contexts/CanvasDataContext';
import { useCanvasActions } from '@/spaces/canvas/hooks/useCanvasActions';
import { useCanvasUI } from '@/spaces/canvas/contexts/CanvasUIContext';
import { useProjectLayout } from '@/app/contexts/ProjectLayoutContext';
import { cn } from '@/utils/classnames';
import NodeToolbar from './NodeToolbar';
import { NodeFloatMenu, IMAGE_TOOLS } from '@/features/mini-tools';
import DataNodeHandle from '../../common/DataNodeHandle';
import NodeSkeleton, { zoomLevelShowContentSelector } from '../../common/NodeSkeleton';

/** Edge handle IDs aligned with canvas conventions. */
const targetHandleId = 'Image_0_0';
const sourceHandleId = 'Image_0_0';

/** Default node size when empty; portrait fixes width, landscape fixes height. */
const defaultNodeWidth = 300;
const defaultNodeHeight = 250;

type ImageNodeData = {
  name?: string;
  content?: string;
  width?: number;
  height?: number;
  state?: string;
  errorMessage?: string;
};

const ImageNode: React.FC<NodeProps> = ({ id, selected, dragging }) => {
  const { t } = useTranslation();
  const { nodes } = useCanvasData();
  const { onNodesChange } = useCanvasActions();
  const { openRightPanel } = useProjectLayout();
  const { openCanvasOverlayPanel, closeCanvasOverlayPanel, canvasOverlayPanel } = useCanvasUI();
  const showContent = useStore(zoomLevelShowContentSelector);
  const [previewVisible, setPreviewVisible] = useState(false);
  /** Content area size derived from image ratio: portrait fixed width, landscape fixed height. */
  const [contentHeight, setContentHeight] = useState<number | null>(null);
  const [contentWidth, setContentWidth] = useState<number | null>(null);

  /** Derived from node data: current image URL from data.content (new schema). */
  const currentNode = nodes.find((n: { id: string }) => n.id === id);
  const nodeData = currentNode?.data as ImageNodeData | undefined;
  /** Direct read of data.content — no history indirection in canvas-native schema. */
  const imageUrlFromData = nodeData?.content ?? '';
  const isHandling = nodeData?.state === 'handling';
  const errorMessage = nodeData?.errorMessage;
  const [imageUrl, setImageUrl] = useState(imageUrlFromData);

  /** Sync local state from data.content and dimensions. */
  useEffect(() => {
    if (imageUrlFromData !== imageUrl) {
      setImageUrl(imageUrlFromData);
    }
    if (!imageUrlFromData) {
      setContentHeight(null);
      setContentWidth(null);
    } else {
      const w = nodeData?.width;
      const h = nodeData?.height;
      if (typeof w === 'number' && typeof h === 'number' && w > 0 && h > 0) {
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
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imageUrlFromData, nodeData?.width, nodeData?.height]);

  const handleToolbarInfoClick = () => {
    const isCurrentNodePanelOpen = canvasOverlayPanel.open && canvasOverlayPanel.nodeId === id;
    if (isCurrentNodePanelOpen) {
      closeCanvasOverlayPanel();
      return;
    }
    openCanvasOverlayPanel(id);
  };

  /** Placeholder click: stop propagation and select this node. */
  const handlePlaceholderClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    onNodesChange(nodes.map((n: { id: string }) => ({ type: 'select' as const, id: n.id, selected: n.id === id })));
  };

  const handleMentionClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    openRightPanel('editor', id);
  };

  /** Download current image. */
  const handleDownloadClick = async () => {
    const url = imageUrl || imageUrlFromData;
    if (!url) {
      message.warning(t('project.toolbar.noContentToDownload', 'No content to download'));
      return;
    }
    try {
      const res = await fetch(url, { mode: 'cors' });
      if (!res.ok) throw new Error(res.statusText);
      const blob = await res.blob();
      const ext = url.split('?')[0].match(/\.(jpe?g|png|webp|gif|tiff?)$/i)?.[1] || 'jpg';
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `image-${Date.now()}.${ext}`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (err) {
      console.error('Failed to download image:', err);
      message.warning(t('project.toolbar.downloadFailed', 'Download failed'));
    }
  };

  const selectedCount = nodes.filter((n: { selected?: boolean }) => n.selected).length;
  const parentNode = currentNode?.parentId ? nodes.find((n) => n.id === currentNode.parentId) : null;
  const isInsideLockedGroup = parentNode?.type === 'group' && (parentNode.data as { locked?: boolean })?.locked === true;
  const showTopToolbar = !dragging && !isInsideLockedGroup && selected && selectedCount === 1;
  const displayImageUrl = imageUrl || imageUrlFromData;

  /** Track node hover to control plus-handle visibility. */
  const [nodeHovered, setNodeHovered] = useState(false);

  /** On image load: portrait keeps fixed width; landscape keeps minimum height with proportional width. */
  const handleImageLoad = (naturalWidth: number, naturalHeight: number) => {
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

  /** Open the right chat panel as image editor (resource list + resizable editor area). */
  return (
    <>
      <FlowNodeToolbar position={Position.Top} align='center' offset={40} isVisible={showTopToolbar}>
        <div className='rounded-[8px] pointer-events-auto' onMouseDown={(e) => e.stopPropagation()}>
          <NodeToolbar
            nodeId={id}
            onTakePhotoClick={handleToolbarInfoClick}
          />
        </div>
      </FlowNodeToolbar>
      {/* Mini-tool float menu: only when the node has an asset to operate on. */}
      <FlowNodeToolbar
        position={Position.Top}
        align='center'
        offset={8}
        isVisible={showTopToolbar && Boolean(displayImageUrl)}
      >
        <NodeFloatMenu nodeId={id} tools={IMAGE_TOOLS} />
      </FlowNodeToolbar>
      <div
        className='relative w-0 min-w-0'
        style={{
          width: imageUrl ? (contentWidth ?? defaultNodeWidth) : defaultNodeWidth,
          height: imageUrl ? (contentHeight ?? defaultNodeHeight) : defaultNodeHeight,
        }}
      >
        <div
          className='absolute left-0 -top-0 -translate-y-full overflow-hidden text-left text-ellipsis whitespace-nowrap text-foreground/60'
          style={{
            maxWidth: imageUrl ? (contentWidth ?? defaultNodeWidth) : defaultNodeWidth,
          }}
        >
          <NodeHeader nodeId={id} title={t('project.toolbar.imageNode')} editable={true} />
        </div>
        <div
          className={
            'relative flex min-h-0 flex-col rounded-[8px] bg-background-default-base outline outline-2 pointer-events-auto ' +
            (selected ? 'outline-solid outline-border-utilities-selected' : 'outline-transparent')
          }
          style={{
            width: imageUrl ? (contentWidth ?? defaultNodeWidth) : defaultNodeWidth,
            height: imageUrl ? (contentHeight ?? defaultNodeHeight) : defaultNodeHeight,
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
          <div className={cn('flex-1 min-h-0')}>
            {!showContent ? (
              <NodeSkeleton />
            ) : (
              <div className='w-full h-full min-h-0 flex items-center justify-center rounded-[8px] overflow-hidden'>
                {imageUrl ? (
                  <div
                    className={cn(
                      'relative h-full w-full min-h-0 rounded-[8px] overflow-hidden',
                      errorMessage && !isHandling && 'outline outline-2 outline-red-400',
                    )}
                  >
                    {/* Handling overlay: shown when backend is processing this node. */}
                    {isHandling && (
                      <div className='absolute inset-0 z-[10] flex flex-col items-center justify-center rounded-[8px] bg-black/40 pointer-events-none'>
                        <Icon name='base-loading-spinner' width={28} height={28} className='animate-spin text-white' />
                        <div className='text-[12px] text-white font-normal mt-2'>{t('canvas.node.processing', 'Processing...')}</div>
                      </div>
                    )}
                    {/* Error badge: shown when last op failed (state === 'idle' with errorMessage). */}
                    {errorMessage && !isHandling && (
                      <div className='absolute top-1 right-1 z-[10] max-w-[80%] rounded px-1.5 py-0.5 text-[10px] font-medium text-white bg-red-500 leading-tight truncate' title={errorMessage}>
                        {errorMessage}
                      </div>
                    )}
                    <ImageNodeContent
                      key={imageUrl}
                      src={imageUrl}
                      selected={selected}
                      isInsideLockedGroup={isInsideLockedGroup}
                      previewOpen={previewVisible}
                      onPreviewChange={(open) => setPreviewVisible(open)}
                      onDownloadClick={handleDownloadClick}
                      onMentionClick={handleMentionClick}
                      onImageLoad={handleImageLoad}
                      imageCursorClassName='cursor-grab'
                      hideFloatingToolbar={false}
                    />
                  </div>
                ) : isHandling ? (
                  /* No content yet but backend is processing: show full-area spinner */
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
                      name='project-image-node-placeholder'
                      width={42}
                      height={42}
                      className='text-text-default-tertiary'
                    />
                    <div className='text-center text-[12px] font-normal text-text-default-tertiary'>
                      {t('canvas.node.image.emptyHint', '点左侧菜单"上传"添加素材')}
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

export default memo(ImageNode);
