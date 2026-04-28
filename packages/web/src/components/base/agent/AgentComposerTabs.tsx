import React, { memo, useEffect, useMemo, useRef, useState } from 'react';
import { autoUpdate, flip, offset, shift, useDismiss, useFloating, FloatingPortal } from '@floating-ui/react';
import { cn } from '@/utils/classnames';
import { Icon } from '@/components/base/icon';
import Tooltip from '@/components/base/tooltip';
import {
  AgentResourcePreviewContent,
  useAgentResourcePreviewVideoSize,
  type AgentPreviewResource,
} from './AgentResourcePreview';
import Divider from '@/components/base/divider';
import Upload, { type UploadFile } from '@/components/base/upload';
import { useCanvasData } from '@/contexts/CanvasDataContext';
import { useUpstreamExternalFileList } from '@/hooks/useUpstreamExternalFileList';

/** Thumbnail metadata for upstream canvas outputs. */
export type AgentComposerUpstreamItem = {
  id: string;
  previewUrl: string;
  name?: string;
  mediaType?: 'image' | 'video' | 'audio' | 'text' | 'file';
};

/** Local file staged in the composer toolbar. */
export type AgentComposerUploadItem = {
  id: string;
  type: 'image' | 'file' | 'text' | 'audio' | 'video';
  previewUrl?: string;
  name?: string;
};

export type AgentComposerTabsProps = {
  className?: string;
  upstreamItems?: AgentComposerUpstreamItem[];
  /** When set, upstream thumbnails are resolved from incoming edges to this node. */
  upstreamTargetNodeId?: string;
  onUpstreamItemsChange?: (items: AgentComposerUpstreamItem[]) => void;
  uploadItems: AgentComposerUploadItem[];
  onLayoutClick?: () => void;
  onMentionClick?: () => void;
  onUpstreamItemClick?: (item: AgentComposerUpstreamItem) => void;
  onRemoveUpstreamItem?: (id: string) => void;
  onFilesSelected?: (files: File[]) => void;
  onRemoveUpload?: (id: string) => void;
  onUploadItemClick?: (item: AgentComposerUploadItem) => void;
  onTrailingClick?: () => void;
  trailingActionsSlot?: React.ReactNode;
  showTrailingActions?: boolean;
  showMention?: boolean;
  showUploadDivider?: boolean;
  showTrailingDivider?: boolean;
  accept?: string;
  multiple?: boolean;
  disabled?: boolean;
};

const squareBtnClass = 'flex h-10 w-10 shrink-0 cursor-pointer select-none items-center justify-center rounded-[6px] border border-[var(--color-border-default-base)] bg-background-default-base text-[var(--color-icon-base)] transition-colors hover:bg-[var(--color-background-default-base-hover)] disabled:cursor-not-allowed disabled:opacity-50';

/** Outer shell: allows remove control to extend past the thumbnail (inner frame clips media). */
const thumbShellClass = 'relative h-10 w-10 shrink-0';

const thumbFrameClass = 'flex h-full w-full items-center justify-center overflow-hidden rounded-[6px] border border-[var(--color-border-default-base)] bg-background-default-base p-0';

/** Centered on the thumbnail’s top-right corner; half of the control sits outside the image. */
const thumbRemoveBtnClass = 'absolute right-0 top-0 z-[2] flex h-[18px] w-[18px] translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border-0 bg-black/65 p-0 text-white shadow-sm opacity-0 outline-none transition-opacity hover:bg-black/80 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-black/30 group-hover:opacity-100 pointer-events-none group-hover:pointer-events-auto';

const thumbInnerClass = 'flex h-full w-full min-h-0 min-w-0 items-center justify-center overflow-hidden';

const thumbImgClass = 'h-full w-full min-h-0 min-w-0 object-cover object-center';

const renderUploadThumb = (item: AgentComposerUploadItem) => {
  if (item.type === 'image' && item.previewUrl) {
    return (
      <div className={thumbInnerClass}>
        <img src={item.previewUrl} alt='' className={thumbImgClass} />
      </div>
    );
  }
  if (item.type === 'video' && item.previewUrl) {
    return (
      <div className={cn(thumbInnerClass, 'relative')}>
        <video
          src={item.previewUrl}
          preload='metadata'
          muted
          playsInline
          className='absolute inset-0 h-full w-full object-cover pointer-events-none'
        />
        <div className='pointer-events-none absolute inset-0 flex items-center justify-center bg-black/25'>
          <Icon name='project-play-audio-icon' width={14} height={14} color='#fff' />
        </div>
      </div>
    );
  }
  if (item.type === 'text') {
    return (
      <div className={cn(thumbInnerClass, 'flex items-center justify-center')}>
        <Icon name='project-chat-text-doc-icon' width={18} height={18} color='var(--color-icon-base)' />
      </div>
    );
  }
  if (item.type === 'audio') {
    return (
      <div className={cn(thumbInnerClass, 'flex items-center justify-center')}>
        <Icon name='project-chat-audio-icon' width={20} height={20} color='var(--color-icon-base)' />
      </div>
    );
  }
  return (
    <div className={cn(thumbInnerClass, 'flex items-center justify-center')}>
      <Icon name='project-chat-doc-icon' width={20} height={20} color='var(--color-icon-base)' />
    </div>
  );
};

const stripPreviewCloseDelayMs = 160;

function upstreamItemToPreview(item: AgentComposerUpstreamItem): AgentPreviewResource {
  const type = item.mediaType ?? 'file';
  return {
    url: item.previewUrl ?? '',
    label: item.name ?? 'Upstream',
    type,
  };
}

function uploadItemToPreview(item: AgentComposerUploadItem): AgentPreviewResource {
  return {
    url: item.previewUrl ?? '',
    label: item.name ?? (item.type === 'text' ? 'Text' : 'File'),
    type: item.type,
  };
}

const renderUpstreamThumb = (item: AgentComposerUpstreamItem) => {
  if (item.mediaType === 'video' && item.previewUrl) {
    return (
      <div className={cn(thumbInnerClass, 'relative')}>
        <video
          src={item.previewUrl}
          preload='metadata'
          muted
          playsInline
          className='absolute inset-0 h-full w-full object-cover pointer-events-none'
        />
        <div className='pointer-events-none absolute inset-0 flex items-center justify-center bg-black/25'>
          <Icon name='project-play-audio-icon' width={14} height={14} color='#fff' />
        </div>
      </div>
    );
  }
  if (item.mediaType === 'image' && item.previewUrl) {
    return (
      <div className={thumbInnerClass}>
        <img src={item.previewUrl} alt='' className={thumbImgClass} />
      </div>
    );
  }
  if (item.mediaType === 'text') {
    return (
      <div className={cn(thumbInnerClass, 'flex items-center justify-center')}>
        <Icon name='project-chat-text-doc-icon' width={18} height={18} color='var(--color-icon-base)' />
      </div>
    );
  }
  if (item.mediaType === 'audio') {
    return (
      <div className={cn(thumbInnerClass, 'flex items-center justify-center')}>
        <Icon name='project-chat-audio-icon' width={20} height={20} color='var(--color-icon-base)' />
      </div>
    );
  }
  return (
    <div className={cn(thumbInnerClass, 'flex items-center justify-center')}>
      <Icon name='project-chat-doc-icon' width={20} height={20} color='var(--color-icon-base)' />
    </div>
  );
};

/** Toolbar row above the agent input: layout, @ upstream strip, uploads, optional trailing actions. */
const AgentComposerTabsComponent: React.FC<AgentComposerTabsProps> = ({
  className,
  upstreamItems: upstreamItemsProp,
  upstreamTargetNodeId,
  onUpstreamItemsChange,
  uploadItems,
  onLayoutClick,
  onMentionClick,
  onUpstreamItemClick,
  onRemoveUpstreamItem,
  onFilesSelected,
  onRemoveUpload: _onRemoveUpload,
  onUploadItemClick,
  onTrailingClick,
  trailingActionsSlot,
  showTrailingActions = true,
  showMention = true,
  showUploadDivider = true,
  showTrailingDivider = true,
  accept = 'image/*,video/*,audio/*,.txt,text/plain',
  multiple = true,
  disabled = false,
}) => {
  const { nodes, edges } = useCanvasData();
  const lastNotifiedUpstreamSignatureRef = useRef<string>('');
  const [stripPreview, setStripPreview] = useState<{
    resource: AgentPreviewResource;
    anchor: HTMLElement;
  } | null>(null);
  const stripPreviewCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const stripPreviewOpen = stripPreview !== null;
  const stripPreviewVideoSize = useAgentResourcePreviewVideoSize(stripPreviewOpen, stripPreview?.resource ?? null);

  const clearStripPreviewCloseTimer = () => {
    if (stripPreviewCloseTimerRef.current) {
      clearTimeout(stripPreviewCloseTimerRef.current);
      stripPreviewCloseTimerRef.current = null;
    }
  };

  const scheduleStripPreviewClose = () => {
    clearStripPreviewCloseTimer();
    stripPreviewCloseTimerRef.current = setTimeout(() => setStripPreview(null), stripPreviewCloseDelayMs);
  };

  const openStripPreview = (anchor: HTMLElement, resource: AgentPreviewResource) => {
    clearStripPreviewCloseTimer();
    setStripPreview({ anchor, resource });
  };

  const {
    refs: stripPreviewRefs,
    floatingStyles: stripPreviewFloatingStyles,
    context: stripPreviewContext,
  } = useFloating({
    open: stripPreviewOpen,
    onOpenChange: (open) => {
      if (!open) setStripPreview(null);
    },
    placement: 'top',
    whileElementsMounted: autoUpdate,
    middleware: [offset(8), flip({ padding: 8 }), shift({ padding: 8 })],
  });
  useDismiss(stripPreviewContext);

  useEffect(() => {
    if (stripPreview?.anchor) {
      stripPreviewRefs.setReference(stripPreview.anchor);
    }
  }, [stripPreview, stripPreviewRefs]);

  useEffect(
    () => () => {
      clearStripPreviewCloseTimer();
    },
    [],
  );

  const upstreamExternalItems = useUpstreamExternalFileList(nodes, edges, upstreamTargetNodeId ?? '');

  const upstreamItems = useMemo((): AgentComposerUpstreamItem[] => {
    if (upstreamTargetNodeId !== undefined) {
      if (!upstreamTargetNodeId) return [];
      return upstreamExternalItems.map((it) => ({
        id: it.uid,
        previewUrl: it.content ?? '',
        name: it.name,
        mediaType: it.type,
      }));
    }

    if (!upstreamTargetNodeId) return upstreamItemsProp ?? [];
    return upstreamExternalItems.map((it) => ({
      id: it.uid,
      previewUrl: it.content ?? '',
      name: it.name,
      mediaType: it.type,
    }));
  }, [upstreamExternalItems, upstreamItemsProp, upstreamTargetNodeId]);

  useEffect(() => {
    // Avoid parent state update loops when upstreamItems array identity changes
    // but the actual displayed content stays the same.
    const signature = JSON.stringify(
      upstreamItems.map((item) => ({
        id: item.id,
        previewUrl: item.previewUrl,
        name: item.name,
        mediaType: item.mediaType,
      })),
    );
    if (lastNotifiedUpstreamSignatureRef.current === signature) return;
    lastNotifiedUpstreamSignatureRef.current = signature;
    onUpstreamItemsChange?.(upstreamItems);
  }, [onUpstreamItemsChange, upstreamItems]);

  const handleUploadChange = (info: { fileList: UploadFile[] }) => {
    const files = info.fileList.map((f) => f.originFileObj).filter((f): f is File => f != null);
    if (files.length) onFilesSelected?.(files);
  };

  const stopPropagationMouseDown = (e: React.MouseEvent<HTMLElement>) => {
    e.preventDefault();
    e.stopPropagation();
  };

  const upstreamItemById = useMemo(
    () => new Map(upstreamItems.map((i) => [i.id, i])),
    [upstreamItems],
  );
  const uploadItemById = useMemo(
    () => new Map(uploadItems.map((i) => [i.id, i])),
    [uploadItems],
  );

  useEffect(() => {
    if (!stripPreview) return;
    const anchorGone = !stripPreview.anchor.isConnected;
    if (anchorGone) {
      setStripPreview(null);
      return;
    }

    const anchorId = stripPreview.anchor.dataset.itemId;
    if (!anchorId) {
      setStripPreview(null);
      return;
    }

    const existsInUpstream = upstreamItemById.has(anchorId);
    const existsInUpload = uploadItemById.has(anchorId);
    if (!existsInUpstream && !existsInUpload) {
      setStripPreview(null);
    }
  }, [stripPreview, upstreamItemById, uploadItemById]);

  const handleUpstreamItemClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const id = e.currentTarget.dataset.itemId;
    if (!id) return;
    const item = upstreamItemById.get(id);
    if (!item) return;
    onUpstreamItemClick?.(item);
  };

  const handleUpstreamItemKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    const id = e.currentTarget.dataset.itemId;
    if (!id) return;
    const item = upstreamItemById.get(id);
    if (!item) return;
    onUpstreamItemClick?.(item);
  };

  const handleUploadItemClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const id = e.currentTarget.dataset.itemId;
    if (!id) return;
    const item = uploadItemById.get(id);
    if (!item) return;
    onUploadItemClick?.(item);
  };

  const handleUploadItemKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    const id = e.currentTarget.dataset.itemId;
    if (!id) return;
    const item = uploadItemById.get(id);
    if (!item) return;
    onUploadItemClick?.(item);
  };

  const handleRemoveUploadClick = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.preventDefault();
    e.stopPropagation();
    const id = e.currentTarget.dataset.itemId;
    if (!id) return;
    _onRemoveUpload?.(id);
  };

  const handleRemoveUpstreamItemClick = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.preventDefault();
    e.stopPropagation();
    const id = e.currentTarget.dataset.itemId;
    if (!id) return;
    onRemoveUpstreamItem?.(id);
  };

  return (
    <div
      className={cn(
        'flex select-none items-center gap-1.5 rounded-lg bg-background-default-secondary p-[8px]',
        className,
      )}
    >
      <div className='flex min-w-0 flex-1 flex-wrap items-center gap-1.5'>
        <Tooltip title='Focus editor' placement='top' offset={4}>
          <button
            type='button'
            className={squareBtnClass}
            aria-label='Focus editor'
            onMouseDown={(e) => {
              e.preventDefault();
              e.stopPropagation();
            }}
            onClick={onLayoutClick}
          >
            <Icon name='project-chat-input-tabs-icon' width={16} height={16} />
          </button>
        </Tooltip>

        {showMention ? (
          <Tooltip title='Mention' placement='top' offset={4}>
            <button
              type='button'
              className={squareBtnClass}
              aria-label='Mention upstream'
              onMouseDown={stopPropagationMouseDown}
              onClick={onMentionClick}
            >
              <Icon name='project-chat-mention-icon' width={16} height={16} />
            </button>
          </Tooltip>
        ) : null}

        {upstreamItems.length > 0 ? (
          <div className='contents'>
            {upstreamItems.map((item) => (
              <div key={item.id} className='flex'>
                <div
                  className={cn(thumbShellClass, 'cursor-pointer group')}
                  aria-label={item.name ?? 'Upstream resource'}
                  data-item-id={item.id}
                  onMouseDown={stopPropagationMouseDown}
                  onClick={handleUpstreamItemClick}
                  tabIndex={0}
                  onKeyDown={handleUpstreamItemKeyDown}
                  onMouseEnter={(e) => openStripPreview(e.currentTarget, upstreamItemToPreview(item))}
                  onMouseLeave={scheduleStripPreviewClose}
                >
                  <div className={thumbFrameClass}>{renderUpstreamThumb(item)}</div>
                  {onRemoveUpstreamItem ? (
                    <button
                      type='button'
                      className={thumbRemoveBtnClass}
                      data-item-id={item.id}
                      onMouseDown={stopPropagationMouseDown}
                      onClick={handleRemoveUpstreamItemClick}
                      aria-label='Remove upstream'
                    >
                      <Icon name='base-close-icon' width={10} height={10} color='#fff' />
                    </button>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        ) : null}

        {showUploadDivider ? (
          <Divider type='vertical' className='h-10 shrink-0 self-center bg-[var(--color-border-default-base)]' />
        ) : null}

        <Upload
          accept={accept}
          multiple={multiple}
          disabled={disabled}
          showUploadList={false}
          fileList={[]}
          onChange={handleUploadChange}
        >
          <Tooltip title='Upload' placement='top' offset={4}>
            <button
              type='button'
              className={squareBtnClass}
              aria-label='Upload files'
              disabled={disabled}
              onMouseDown={stopPropagationMouseDown}
            >
              <Icon name='project-chat-upload-add-icon' width={16} height={16} />
            </button>
          </Tooltip>
        </Upload>

        {uploadItems.length > 0 ? (
          <div className='contents'>
            {uploadItems.map((item) => (
              <div key={item.id} className='flex'>
                <div
                  className={cn(thumbShellClass, 'cursor-pointer group')}
                  aria-label={item.name ?? 'Attachment'}
                  data-item-id={item.id}
                  onMouseDown={stopPropagationMouseDown}
                  onClick={handleUploadItemClick}
                  tabIndex={0}
                  onKeyDown={handleUploadItemKeyDown}
                  onMouseEnter={(e) => openStripPreview(e.currentTarget, uploadItemToPreview(item))}
                  onMouseLeave={scheduleStripPreviewClose}
                >
                  <div className={thumbFrameClass}>{renderUploadThumb(item)}</div>
                  {_onRemoveUpload ? (
                    <button
                      type='button'
                      className={thumbRemoveBtnClass}
                      data-item-id={item.id}
                      onMouseDown={stopPropagationMouseDown}
                      onClick={handleRemoveUploadClick}
                      aria-label='Remove upload'
                    >
                      <Icon name='base-close-icon' width={10} height={10} color='#fff' />
                    </button>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        ) : null}
      </div>

      {showTrailingActions ? (
        <div className='flex shrink-0 self-stretch items-start gap-2'>
          {showTrailingDivider ? (
            <Divider type='vertical' className='h-auto shrink-0 self-stretch bg-[var(--color-border-default-base)]' />
          ) : null}
          <Tooltip title='Add to input' placement='top' offset={4} triggerClassName='self-start'>
            <button
              type='button'
              className={squareBtnClass}
              aria-label='Add to input'
              onMouseDown={stopPropagationMouseDown}
              onClick={onTrailingClick}
            >
              <Icon name='project-chat-composer-trailing-layout-icon' width={16} height={16} />
            </button>
          </Tooltip>
          {trailingActionsSlot}
        </div>
      ) : null}

      {stripPreviewOpen && stripPreview ? (
        <FloatingPortal>
          <div
            ref={stripPreviewRefs.setFloating}
            style={stripPreviewFloatingStyles}
            className={cn(
              'z-[600] rounded-lg border shadow-lg',
              'border-[var(--color-border-default-base)] bg-[var(--color-background-default-base)]',
              stripPreview.resource.type === 'video' || stripPreview.resource.type === 'image'
                ? 'overflow-hidden'
                : 'p-2',
            )}
            onMouseEnter={clearStripPreviewCloseTimer}
            onMouseLeave={scheduleStripPreviewClose}
          >
            <AgentResourcePreviewContent
              resource={stripPreview.resource}
              videoSize={stripPreviewVideoSize}
              textContent={stripPreview.resource.type === 'text' ? stripPreview.resource.url : null}
            />
          </div>
        </FloatingPortal>
      ) : null}
    </div>
  );
};

const AgentComposerTabs = memo(AgentComposerTabsComponent);
export default AgentComposerTabs;
