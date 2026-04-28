/**
 * Image input node (ImageNode)
 * - Supports local image upload
 * - Uses default height when empty; adapts by image ratio when content exists
 * - Shows NodeToolbar when selected (Editor / Upload / Take photo)
 * - Local preview via blob URLs (no upload API)
 */
import React, { useState, useEffect, memo, useRef, useCallback, useMemo } from 'react';
import { type NodeProps, Position, NodeToolbar as FlowNodeToolbar, useStore } from '@xyflow/react';
import { Upload } from '@/components/base/upload';
import { message } from '@/components/base/message';
import { useTranslation } from 'react-i18next';
import NodeHeader from '../../common/NodeHeader';
import ImageNodeContent from './ImageNodeContent';
import { Icon } from '@/components/base/icon';
import { useCanvasData } from '@/contexts/CanvasDataContext';
import { useCanvasActions } from '@/hooks/useCanvasActions';
import { useCanvasUI } from '@/hooks/useCanvasUI';
import { useActiveHistoryItem } from '@/hooks/useActiveHistoryItem';
import type { HistoryItem } from '@breatic/shared';
import { cn } from '@/utils/classnames';
import { getImageMeta } from '@/utils/mediaUtils';
import {
  shouldHideNodeChatComposerForChatRecordCanvasPick,
  type PickPending,
  type PickResultBox,
  type CanvasWorkflowNodeData,
} from '@/apps/project/components/canvas/types';
import NodeToolbar from './NodeToolbar';
import DataNodeHandle from '../../common/DataNodeHandle';
import NodeSkeleton, { zoomLevelShowContentSelector } from '../../common/NodeSkeleton';
import NodeChatComposer from '@/apps/project/components/agent/NodeChatComposer';
import RecognizedPickDropdown from '@/components/base/agent/RecognizedPickDropdown';

/** Edge handle IDs aligned with canvas conventions. */
const targetHandleId = 'Image_0_0';
const sourceHandleId = 'Image_0_0';

/** Default node size when empty; portrait fixes width, landscape fixes height. */
const defaultNodeWidth = 300;
const defaultNodeHeight = 250;
const recognizedOverlayPresets = [
  { key: 'mountain', label: '山脉', cxPct: 28, cyPct: 24, wPct: 32, hPct: 26 },
  { key: 'river', label: '河流', cxPct: 56, cyPct: 62, wPct: 38, hPct: 20 },
  { key: 'tree', label: '大树', cxPct: 76, cyPct: 42, wPct: 20, hPct: 34 },
] as const;

type ImageNodeData = { name?: string; activeHistoryId?: string; history?: HistoryItem[]; pickState?: CanvasWorkflowNodeData['pickState'] };

const ImageNode: React.FC<NodeProps> = ({ id, selected, dragging }) => {
  const { t } = useTranslation();
  const { nodes } = useCanvasData();
  const { updateNode, pushHistoryItem, setActiveHistoryId, onNodesChange } = useCanvasActions();
  const {
    openRightPanel,
    requestAddResourceToInput,
    openCanvasOverlayPanel,
    closeCanvasOverlayPanel,
    canvasOverlayPanel,
  } = useCanvasUI();
  const showContent = useStore(zoomLevelShowContentSelector);
  const [isLoading, setIsLoading] = useState(false);
  const uploadInputRef = useRef<HTMLInputElement>(null);
  /** During replacement upload, record the starting imageUrl to avoid stale onload closing loading too early. */
  const imageUrlWhenUploadStartedRef = useRef<string>('');
  const [previewVisible, setPreviewVisible] = useState(false);
  /** Content area size derived from image ratio: portrait fixed width, landscape fixed height. */
  const [contentHeight, setContentHeight] = useState<number | null>(null);
  const [contentWidth, setContentWidth] = useState<number | null>(null);

  /** Derived from node data: current image URL via active history item. */
  const currentNode = nodes.find((n: { id: string }) => n.id === id);
  const nodeData = currentNode?.data as ImageNodeData | undefined;
  const pick = nodeData?.pickState;
  const wf = nodeData as Partial<CanvasWorkflowNodeData> | undefined;
  const activeItem = useActiveHistoryItem(nodeData as { activeHistoryId?: string; history: HistoryItem[] } | undefined);
  const imageUrlFromData = activeItem?.url ?? '';
  const [imageUrl, setImageUrl] = useState(imageUrlFromData);

  /** Sync local state from active history item URL and dimensions. */
  useEffect(() => {
    if (imageUrlFromData !== imageUrl) {
      setImageUrl(imageUrlFromData);
    }
    if (!imageUrlFromData) {
      setContentHeight(null);
      setContentWidth(null);
    } else {
      const w = activeItem?.width;
      const h = activeItem?.height;
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
  }, [imageUrlFromData, activeItem?.width, activeItem?.height]);

  /** Compute content area size from source dimensions. */
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

  /** Local file: object URL — writes a history item + sets activeHistoryId. */
  const customRequest = async (options: {
    file: File;
    onSuccess: (response: unknown) => void;
    onError: (error: Error) => void;
  }) => {
    const { file, onSuccess, onError } = options;
    setIsLoading(true);
    try {
      const meta = await getImageMeta(file);
      if (meta.width != null && meta.height != null) {
        applyContentSizeFromDimensions(meta.width, meta.height);
      }
      const resourceUrl = URL.createObjectURL(file);
      const historyId = crypto.randomUUID();
      pushHistoryItem(id, {
        id: historyId,
        url: resourceUrl,
        width: meta.width ?? undefined,
        height: meta.height ?? undefined,
        by: { userId: 'local', username: 'local' },
        createdAt: Date.now(),
        source: 'upload',
        status: 'done',
      });
      setActiveHistoryId(id, historyId);
      onSuccess(resourceUrl);
    } catch (error) {
      console.error('Upload failed:', error);
      message.warning('Image upload failed');
      setIsLoading(false);
      onError(error as Error);
    }
  };

  /** Close loading after image preload completes for the newly uploaded URL only. */
  useEffect(() => {
    if (!imageUrl || !isLoading) return;
    if (imageUrl === imageUrlWhenUploadStartedRef.current) return;
    const img = document.createElement('img');
    img.onload = () => setIsLoading(false);
    img.onerror = () => setIsLoading(false);
    img.src = imageUrl;
    return () => {
      img.onload = null;
      img.onerror = null;
    };
  }, [imageUrl, isLoading]);

  /** Update imageUrl immediately on upload success for consistent refresh behavior. */
  const handleUploadSuccess = (response: unknown) => {
    const url = typeof response === 'string' ? response : '';
    if (url) setImageUrl(url);
  };

  /** Wrap customRequest to sync local imageUrl before forwarding success callback. */
  const customRequestWithSync = (options: {
    file: File;
    onProgress?: (percent: number) => void;
    onSuccess: (response: unknown) => void;
    onError: (error: Error) => void;
  }) => {
    customRequest({
      file: options.file,
      onSuccess: (res) => {
        handleUploadSuccess(res);
        options.onSuccess(res);
      },
      onError: options.onError,
    });
  };

  /** Toolbar Upload: trigger the same upload flow used inside the node. */
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
    imageUrlWhenUploadStartedRef.current = imageUrl;
    setIsLoading(true);
    customRequestWithSync({
      file,
      onSuccess: () => {},
      onError: () => {},
    });
  };

  /** Placeholder click: stop propagation and select this node. */
  const handlePlaceholderClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    onNodesChange(nodes.map((n: { id: string }) => ({ type: 'select' as const, id: n.id, selected: n.id === id })));
  };

  // TODO: replaced by presigned URL upload hook

  /** Mention action: add resource to side input and open right editor panel. */
  const handleMentionClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    const url = imageUrl || imageUrlFromData;
    if (url) {
      const nameFromUrl = url.split('/').pop()?.split('?')[0] || 'image';
      requestAddResourceToInput({ url, name: nameFromUrl, type: 'image' });
    }
    openRightPanel('editor', id, undefined, true);
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
  const agentCanvasPickFromCanvas = Boolean(pick?.fromCanvas);
  const baseToolbarVisible = !dragging && !isInsideLockedGroup && ((selected && selectedCount === 1) || agentCanvasPickFromCanvas);
  const showTopToolbar = baseToolbarVisible && !agentCanvasPickFromCanvas;
  const showBottomNodeChatComposer = baseToolbarVisible && !shouldHideNodeChatComposerForChatRecordCanvasPick(wf);

  const agentCanvasPickSourceNodeId = nodes.find((n) =>
    Boolean((n.data as Partial<CanvasWorkflowNodeData> | undefined)?.pickState?.fromCanvas),
  )?.id;
  const displayImageUrl = imageUrl || imageUrlFromData;
  let imageContentCursorClass = 'cursor-grab';
  if (
    agentCanvasPickSourceNodeId != null &&
    Boolean(displayImageUrl) &&
    (agentCanvasPickSourceNodeId !== id || agentCanvasPickFromCanvas)
  ) {
    imageContentCursorClass = 'cursor-pointer';
  }

  /** During focused picking, render one "recognizing" bubble per pending request on this node. */
  const agentCanvasPickPendingListForThis = nodes.reduce<PickPending[]>((acc, n) => {
    const ps = (n.data as Partial<CanvasWorkflowNodeData> | undefined)?.pickState;
    const list = ps?.pendingList ?? [];
    const matched = list.filter((item) => item.targetNodeId === id);
    if (matched.length > 0) {
      acc.push(...matched);
      return acc;
    }
    const legacy = ps?.pending ?? null;
    if (legacy?.targetNodeId === id) acc.push(legacy);
    return acc;
  }, []);
  const isAgentCanvasPickRecognizingTarget = agentCanvasPickPendingListForThis.length > 0;
  const pickResultBoxes = useMemo<PickResultBox[]>(() => pick?.resultBoxes ?? [], [pick?.resultBoxes]);
  const imagePickOverlayOverflow = isAgentCanvasPickRecognizingTarget || pickResultBoxes.length > 0;

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

  const handleChatInputSend = (content: string, imageUrls?: string[]) => {
    // eslint-disable-next-line no-console
    console.log('ImageNode ChatInput send:', { nodeId: id, content, imageUrls });
    // TODO: Wire this to the ChatMessage list bound to this node.
  };

  const handleRecognizedOverlaySelect = useCallback(
    (box: PickResultBox, presetKey: string) => {
      const preset = recognizedOverlayPresets.find((item) => item.key === presetKey);
      if (!preset || !box.placeholderId) return;
      const nextBoxes = pickResultBoxes.map((item) =>
        item.placeholderId === box.placeholderId
          ? {
            ...item,
            name: preset.label,
            cxPct: preset.cxPct,
            cyPct: preset.cyPct,
            wPct: preset.wPct,
            hPct: preset.hPct,
          }
          : item,
      );
      updateNode(
        id,
        { data: { pickState: { resultBoxes: nextBoxes.length ? nextBoxes : null } } },
        { history: 'skip' },
      );
      if (!box.sourceNodeId || !box.content) return;
      updateNode(
        box.sourceNodeId,
        {
          data: {
            pickState: {
              selection: {
                targetNodeId: id,
                placeholderId: box.placeholderId,
                content: box.content,
                name: preset.label,
                resourceType: box.resourceType ?? 'image',
              },
            },
          },
        },
        { history: 'skip' },
      );
    },
    [id, pickResultBoxes, updateNode],
  );

  /** Open the right chat panel as image editor (resource list + resizable editor area). */
  return (
    <>
      <input
        ref={uploadInputRef}
        type='file'
        accept='.png,.jpg,.jpeg,.webp,.tiff'
        className='hidden'
        onChange={handleToolbarFileChange}
      />
      <FlowNodeToolbar position={Position.Top} align='center' offset={40} isVisible={showTopToolbar}>
        <div className='rounded-[8px] pointer-events-auto' onMouseDown={(e) => e.stopPropagation()}>
          <NodeToolbar
            nodeId={id}
            isUploading={isLoading}
            onUploadClick={handleToolbarUploadClick}
            onTakePhotoClick={handleToolbarInfoClick}
          />
        </div>
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
          <div className={cn('flex-1 min-h-0', imagePickOverlayOverflow && 'overflow-visible')}>
            {!showContent ? (
              <NodeSkeleton />
            ) : isLoading ? (
              <div className='w-full h-full flex flex-col items-center justify-center text-center'>
                <Icon name='base-loading-spinner' width={32} height={32} className='animate-spin' />
                <div className='text-[12px] text-text-default-tertiary font-normal mt-2'>Loading Image...</div>
              </div>
            ) : (
              <div
                className={cn(
                  'w-full h-full min-h-0 flex items-center justify-center rounded-[8px]',
                  imagePickOverlayOverflow ? 'overflow-visible' : 'overflow-hidden',
                )}
              >
                {imageUrl ? (
                  <div
                    className={cn(
                      'relative h-full w-full min-h-0 rounded-[8px]',
                      imagePickOverlayOverflow ? 'overflow-visible' : 'overflow-hidden',
                    )}
                    data-agent-image-viewport={id}
                  >
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
                      imageCursorClassName={imageContentCursorClass}
                      hideFloatingToolbar={agentCanvasPickFromCanvas}
                    />
                    {pickResultBoxes.map((box, boxIdx) => (
                      <div
                        key={box.placeholderId ?? `${box.cxPct}-${box.cyPct}-${boxIdx}`}
                        className='absolute z-[5] rounded-md border-2 border-[rgb(99,102,241)] bg-[rgb(99,102,241)]/15 shadow-[0_0_0_1px_rgba(255,255,255,0.25)_inset] box-border'
                        style={{
                          left: `${box.cxPct}%`,
                          top: `${box.cyPct}%`,
                          width: `${box.wPct}%`,
                          height: `${box.hPct}%`,
                          transform: 'translate(-50%, -50%)',
                        }}
                      >
                        <div className='absolute -left-1 -top-8 z-[8] pointer-events-auto'>
                          <RecognizedPickDropdown
                            currentLabel={box.name}
                            options={recognizedOverlayPresets.map((item) => ({ key: item.key, label: item.label }))}
                            onSelect={(presetKey) => handleRecognizedOverlaySelect(box, presetKey)}
                          />
                        </div>
                      </div>
                    ))}
                    {agentCanvasPickPendingListForThis.map((pending) => (
                      <div
                        key={pending.placeholderId}
                        className='pointer-events-none absolute z-[7] inline-flex max-w-[126px] min-w-0 items-center gap-1 whitespace-nowrap rounded-full border border-[var(--color-border-default-base)] bg-[var(--color-background-default-secondary)] px-2 py-0.5 text-xs font-medium text-[var(--color-text-default-base)] shadow-sm -translate-x-1/2 -translate-y-1/2'
                        style={{
                          left: pending.overlayAnchor ? `${pending.overlayAnchor.xPct}%` : '50%',
                          top: pending.overlayAnchor ? `${pending.overlayAnchor.yPct}%` : '50%',
                        }}
                      >
                        <span className='mr-1'>⏳</span>识别中...
                      </div>
                    ))}
                  </div>
                ) : (
                  <Upload
                    customRequest={customRequest}
                    showUploadList={false}
                    accept='.png,.jpg,.jpeg,.webp,.tiff'
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
                        name='project-image-node-placeholder'
                        width={42}
                        height={42}
                        className='text-text-default-tertiary'
                      />
                      <div className='text-center text-[12px] font-normal text-text-default-tertiary'>
                        {t('project.toolbar.imageNodePlaceholder')
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
      {/* Bottom FlowNodeToolbar: show a floating ChatInput below when this node is selected. */}
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

export default memo(ImageNode);
