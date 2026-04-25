import React, { useEffect, useRef, useState } from 'react';
import { autoUpdate, flip, offset, shift, useDismiss, useFloating, FloatingPortal } from '@floating-ui/react';
import { cn } from '@/utils/classnames';
import { Icon } from '@/components/base/icon';
import type { AgentComposerUpstreamItem, AgentComposerUploadItem } from './AgentComposerTabs';
import {
  AgentResourcePreviewContent,
  useAgentResourcePreviewVideoSize,
  type AgentPreviewResource,
  type AgentResourceType,
} from './AgentResourcePreview';

export type AgentAtPanelSourceItem =
  | { kind: 'upstream'; item: AgentComposerUpstreamItem }
  | { kind: 'upload'; item: AgentComposerUploadItem };

export type AgentAtPanelProps = {
  upstreamItems: AgentComposerUpstreamItem[];
  uploadItems: AgentComposerUploadItem[];
  onSelect?: (source: AgentAtPanelSourceItem) => void;
};

const iconClass = 'flex h-[34px] w-[34px] flex-shrink-0 items-center justify-center rounded bg-[var(--color-background-default-secondary)]';
const listWrapperClass = 'flex w-[200px] max-h-[220px] flex-col gap-0.5 overflow-y-auto p-1';
const listItemClass =
  'flex w-full cursor-pointer items-center gap-2 rounded-md px-1.5 py-1.5 text-left text-[var(--color-text-default-base)] hover:bg-[var(--color-background-default-secondary)]';

const previewCloseDelayMs = 160;

function sourceToPreview(source: AgentAtPanelSourceItem): AgentPreviewResource {
  if (source.kind === 'upstream') {
    const type: AgentResourceType = source.item.mediaType ?? 'file';
    return {
      url: source.item.previewUrl ?? '',
      label: source.item.name ?? 'Upstream',
      type,
    };
  }
  const item = source.item;
  const type = item.type;
  const label = item.name ?? (type === 'text' ? 'Text' : 'File');
  return {
    url: item.previewUrl ?? '',
    label,
    type,
  };
}

const AgentAtPanel: React.FC<AgentAtPanelProps> = ({ upstreamItems, uploadItems, onSelect }) => {
  const sourceItems: AgentAtPanelSourceItem[] = [
    ...upstreamItems.map((item) => ({ kind: 'upstream' as const, item })),
    ...uploadItems.map((item) => ({ kind: 'upload' as const, item })),
  ];

  const [rowPreview, setRowPreview] = useState<{
    resource: AgentPreviewResource;
    anchor: HTMLElement;
  } | null>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const rowPreviewOpen = rowPreview !== null;
  const rowPreviewVideoSize = useAgentResourcePreviewVideoSize(rowPreviewOpen, rowPreview?.resource ?? null);

  const clearCloseTimer = () => {
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  };

  const scheduleClose = () => {
    clearCloseTimer();
    closeTimerRef.current = setTimeout(() => setRowPreview(null), previewCloseDelayMs);
  };

  const openRowPreview = (anchor: HTMLElement, source: AgentAtPanelSourceItem) => {
    clearCloseTimer();
    setRowPreview({ anchor, resource: sourceToPreview(source) });
  };

  const {
    refs: previewRefs,
    floatingStyles: previewFloatingStyles,
    context: previewContext,
  } = useFloating({
    open: rowPreviewOpen,
    onOpenChange: (open) => {
      if (!open) setRowPreview(null);
    },
    placement: 'top',
    whileElementsMounted: autoUpdate,
    middleware: [offset(8), flip({ padding: 8 }), shift({ padding: 8 })],
  });
  useDismiss(previewContext);

  useEffect(() => {
    if (rowPreview?.anchor) {
      previewRefs.setReference(rowPreview.anchor);
    }
  }, [rowPreview, previewRefs]);

  useEffect(
    () => () => {
      clearCloseTimer();
    },
    [],
  );

  const handleItemClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const idx = Number(e.currentTarget.dataset.idx);
    if (!Number.isFinite(idx)) return;
    const next = sourceItems[idx];
    if (!next) return;
    onSelect?.(next);
  };

  const handleItemKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const idx = Number(e.currentTarget.dataset.idx);
    if (!Number.isFinite(idx)) return;
    const next = sourceItems[idx];
    if (!next) return;
    onSelect?.(next);
  };

  if (!sourceItems.length) return null;

  return (
    <>
      <ul className={listWrapperClass}>
        {sourceItems.map((source, index) => {
          let type: AgentResourceType;
          let name: string;
          let objectUrl: string | undefined;

          if (source.kind === 'upstream') {
            type = source.item.mediaType ?? 'file';
            name = source.item.name ?? 'Upstream';
            objectUrl = source.item.previewUrl;
          } else {
            type = source.item.type;
            name = source.item.name ?? (type === 'text' ? 'Text' : 'File');
            objectUrl = type === 'image' || type === 'video' ? source.item.previewUrl : undefined;
          }

          return (
            <li key={source.kind === 'upstream' ? `up-${source.item.id}` : `ul-${source.item.id}`}>
              <div
                role='button'
                tabIndex={0}
                data-idx={index}
                className={listItemClass}
                onClick={handleItemClick}
                onKeyDown={handleItemKeyDown}
                aria-label={`Select ${name}`}
                onMouseEnter={(e) => openRowPreview(e.currentTarget, source)}
                onMouseLeave={scheduleClose}
              >
                {type === 'image' && objectUrl ? (
                  <div className='h-[34px] w-[34px] flex-shrink-0 overflow-hidden rounded bg-[var(--color-background-default-secondary)]'>
                    <img src={objectUrl} alt={name} className='h-full w-full object-cover object-center' />
                  </div>
                ) : type === 'video' && objectUrl ? (
                  <div className='relative h-[34px] w-[34px] flex-shrink-0 overflow-hidden rounded bg-[var(--color-background-default-secondary)]'>
                    <video src={objectUrl} preload='metadata' muted playsInline className='h-full w-full object-cover' />
                    <span className='absolute inset-0 flex items-center justify-center bg-black/20 pointer-events-none'>
                      <Icon name='project-play-audio-icon' width={14} height={14} color='#fff' />
                    </span>
                  </div>
                ) : type === 'audio' ? (
                  <div className={iconClass}>
                    <Icon name='project-chat-audio-icon' width={18} height={18} color='var(--color-icon-base)' />
                  </div>
                ) : type === 'text' ? (
                  <div className={iconClass}>
                    <Icon name='project-chat-text-doc-icon' width={18} height={18} color='var(--color-icon-base)' />
                  </div>
                ) : (
                  <div className={iconClass}>
                    <Icon name='project-chat-doc-icon' width={18} height={18} color='var(--color-icon-base)' />
                  </div>
                )}

                <div className='min-w-0 flex-1'>
                  <div className='truncate text-[14px] font-bold leading-tight'>{name}</div>
                </div>
              </div>
            </li>
          );
        })}
      </ul>

      {rowPreviewOpen && rowPreview ? (
        <FloatingPortal>
          <div
            ref={previewRefs.setFloating}
            style={previewFloatingStyles}
            className={cn(
              'z-[600] rounded-lg border shadow-lg',
              'border-[var(--color-border-default-base)] bg-[var(--color-background-default-base)]',
              rowPreview.resource.type === 'video' || rowPreview.resource.type === 'image'
                ? 'overflow-hidden'
                : 'p-2',
            )}
            onMouseEnter={clearCloseTimer}
            onMouseLeave={scheduleClose}
          >
            <AgentResourcePreviewContent
              resource={rowPreview.resource}
              videoSize={rowPreviewVideoSize}
              textContent={rowPreview.resource.type === 'text' ? rowPreview.resource.url : null}
            />
          </div>
        </FloatingPortal>
      ) : null}
    </>
  );
};

export default AgentAtPanel;
