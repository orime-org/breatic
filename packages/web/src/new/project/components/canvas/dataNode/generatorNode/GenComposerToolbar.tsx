/**
 * Composer toolbar for local-only {@link LocalGenNode} — focus control + upstream chips (no upload).
 */
import React, { memo, useEffect, useMemo, useRef, useState } from 'react';
import { autoUpdate, flip, offset, shift, useDismiss, useFloating, FloatingPortal } from '@floating-ui/react';
import { cn } from '@/utils/classnames';
import { Icon } from '@/components/base/icon';
import Tooltip from '@/components/base/tooltip';
import {
  AgentResourcePreviewContent,
  useAgentResourcePreviewVideoSize,
  type AgentPreviewResource,
} from '@/components/base/agent/AgentResourcePreview';
import type { UpstreamItem } from './upstreamItems';

export type { UpstreamItem };

const squareBtnClass =
  'flex h-10 w-10 shrink-0 cursor-pointer select-none items-center justify-center rounded-[6px] border border-[var(--color-border-default-base)] bg-background-default-base text-[var(--color-icon-base)] transition-colors hover:bg-[var(--color-background-default-base-hover)] disabled:cursor-not-allowed disabled:opacity-50';

const thumbShellClass = 'relative h-10 w-10 shrink-0';
const thumbFrameClass =
  'flex h-full w-full items-center justify-center overflow-hidden rounded-[6px] border border-[var(--color-border-default-base)] bg-background-default-base p-0';
const thumbRemoveBtnClass =
  'absolute right-0 top-0 z-[2] flex h-[18px] w-[18px] translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border-0 bg-black/65 p-0 text-white shadow-sm opacity-0 outline-none transition-opacity hover:bg-black/80 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-black/30 group-hover:opacity-100 pointer-events-none group-hover:pointer-events-auto';
const thumbInnerClass = 'flex h-full w-full min-h-0 min-w-0 items-center justify-center overflow-hidden';
const thumbImgClass = 'h-full w-full min-h-0 min-w-0 object-cover object-center';

const stripPreviewCloseDelayMs = 160;

function upstreamItemToPreview(item: UpstreamItem): AgentPreviewResource {
  const type = item.mediaType ?? 'file';
  return {
    url: item.previewUrl ?? '',
    label: item.name ?? 'Upstream',
    type,
  };
}

const renderUpstreamThumb = (item: UpstreamItem) => {
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

export type GenComposerToolbarProps = {
  className?: string;
  upstreamItems: UpstreamItem[];
  onUpstreamItemClick?: (item: UpstreamItem) => void;
  onRemoveUpstreamItem?: (item: UpstreamItem) => void;
  onLayoutClick?: () => void;
};

const GenComposerToolbarComponent: React.FC<GenComposerToolbarProps> = ({
  className,
  upstreamItems,
  onUpstreamItemClick,
  onRemoveUpstreamItem,
  onLayoutClick,
}) => {
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
    strategy: 'fixed',
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

  const openStripPreview = (anchor: HTMLElement, resource: AgentPreviewResource) => {
    clearStripPreviewCloseTimer();
    setStripPreview({ anchor, resource });
  };

  const upstreamItemById = useMemo(() => new Map(upstreamItems.map((i) => [i.id, i])), [upstreamItems]);

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
    if (!upstreamItemById.has(anchorId)) {
      setStripPreview(null);
    }
  }, [stripPreview, upstreamItemById]);

  const stopPropagationMouseDown = (e: React.MouseEvent<HTMLElement>) => {
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <div
      className={cn(
        'nodrag nopan flex select-none items-center gap-1.5 rounded-lg bg-background-default-secondary p-[8px]',
        className,
      )}
    >
      <div className='flex min-w-0 flex-wrap items-center gap-1.5'>
        <Tooltip title='Focus editor' placement='top' offset={4}>
          <button
            type='button'
            className={squareBtnClass}
            aria-label='Focus editor'
            onMouseDown={stopPropagationMouseDown}
            onClick={onLayoutClick}
          >
            <Icon name='project-chat-input-tabs-icon' width={16} height={16} />
          </button>
        </Tooltip>

        {upstreamItems.length > 0 ? (
          <div className='contents'>
            {upstreamItems.map((item) => (
              <div key={item.id} className='flex'>
                <div
                  className={cn(thumbShellClass, 'cursor-pointer group')}
                  aria-label={item.name ?? 'Upstream resource'}
                  data-item-id={item.id}
                  onMouseDown={stopPropagationMouseDown}
                  onClick={() => onUpstreamItemClick?.(item)}
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
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        onRemoveUpstreamItem(item);
                      }}
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
      </div>

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

const GenComposerToolbar = memo(GenComposerToolbarComponent);
export default GenComposerToolbar;
