import React, { memo } from 'react';
import { cn } from '@/utils/classnames';
import { Icon } from '@/ui/icon';

/** Supported modalities for a row in {@link MediaResourceListPanel}. */
export type MediaResourceListItemType = 'image' | 'video' | 'audio' | 'text' | 'file';

/**
 * One resource row: preview URL (or text body for `text`), display name, and modality.
 */
export type MediaResourceListItem = {
  id: string;
  /** Thumbnail / media URL, or plain text body when `mediaType === 'text'`. */
  previewUrl: string;
  name?: string;
  mediaType: MediaResourceListItemType;
};

export type MediaResourceListPanelProps = {
  /** When false, nothing is rendered (no layout gap). */
  open: boolean;
  /** Header title (e.g. History, Assets). */
  title: string;
  /** If true, shows a small green status dot before the title. */
  showStatusDot?: boolean;
  onClose: () => void;
  items: MediaResourceListItem[];
  /** Shown when `items.length === 0`. */
  emptyText?: string;
  onItemClick?: (item: MediaResourceListItem) => void;
  className?: string;
};

const itemThumbClass = 'relative aspect-square w-full overflow-hidden rounded-[6px] border border-[var(--color-border-default-base)] bg-[var(--color-background-default-secondary)]';

/**
 * Flyout list panel for mixed media (image / video / audio / text / file). Data-driven; callers supply `items`.
 *
 * @param props.open - Visibility.
 * @param props.title - Header label.
 * @param props.items - Rows to render.
 * @param props.onClose - Close control (header X).
 * @param props.onItemClick - Optional row click.
 */
function MediaResourceListPanelComponent({
  open,
  title,
  showStatusDot = false,
  onClose,
  items,
  emptyText = 'No items',
  onItemClick,
  className,
}: MediaResourceListPanelProps) {
  if (!open) return null;

  return (
    <div
      className={cn(
        'flex w-[248px] max-h-[min(70vh,480px)] shrink-0 flex-col overflow-hidden rounded-xl border border-[var(--color-border-default-base)] bg-background-default-base shadow-[0px_4px_16px_-1px_rgba(12,12,13,0.08),0px_2px_8px_-1px_rgba(12,12,13,0.06)]',
        className,
      )}
      role='dialog'
      aria-label={title}
    >
      <div className='flex shrink-0 items-center justify-between gap-2 border-b border-[var(--color-border-default-base)] px-3 py-2.5'>
        <div className='flex min-w-0 items-center gap-2'>
          {showStatusDot ? (
            <span className='h-2 w-2 shrink-0 rounded-full bg-[#2FB344]' aria-hidden />
          ) : null}
          <span className='truncate text-sm font-semibold text-text-default-base'>{title}</span>
        </div>
        <button
          type='button'
          className='flex h-7 w-7 shrink-0 items-center justify-center rounded-[6px] text-icon-base transition-colors hover:bg-background-default-base-hover'
          aria-label='Close'
          onClick={onClose}
        >
          <Icon name='base-close-icon' width={14} height={14} />
        </button>
      </div>

      <div className='min-h-0 flex-1 overflow-y-auto p-2'>
        {items.length === 0 ? (
          <div className='py-8 text-center text-xs text-text-default-tertiary'>{emptyText}</div>
        ) : (
          <ul className='flex flex-col gap-2'>
            {items.map((item) => (
              <li key={item.id}>
                <button
                  type='button'
                  className='w-full text-left outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-default-base)] rounded-[8px]'
                  onClick={() => onItemClick?.(item)}
                >
                  <div className={cn(itemThumbClass, onItemClick && 'cursor-pointer hover:opacity-95')}>
                    {item.mediaType === 'image' && item.previewUrl ? (
                      <img src={item.previewUrl} alt={item.name ?? ''} className='h-full w-full object-cover' />
                    ) : item.mediaType === 'video' && item.previewUrl ? (
                      <>
                        <video
                          src={item.previewUrl}
                          preload='metadata'
                          muted
                          playsInline
                          className='h-full w-full object-cover'
                        />
                        <span className='pointer-events-none absolute inset-0 flex items-center justify-center bg-black/25'>
                          <Icon name='project-play-audio-icon' width={16} height={16} color='#fff' />
                        </span>
                      </>
                    ) : item.mediaType === 'audio' ? (
                      <div className='flex h-full w-full items-center justify-center'>
                        <Icon name='project-chat-audio-icon' width={28} height={28} color='var(--color-icon-base)' />
                      </div>
                    ) : item.mediaType === 'text' ? (
                      <div className='flex h-full w-full flex-col justify-center gap-1 p-2'>
                        <Icon
                          name='project-chat-text-doc-icon'
                          width={20}
                          height={20}
                          color='var(--color-icon-base)'
                          className='shrink-0'
                        />
                        <span className='line-clamp-3 text-[11px] leading-snug text-text-default-secondary'>
                          {item.previewUrl || item.name || 'Text'}
                        </span>
                      </div>
                    ) : (
                      <div className='flex h-full w-full flex-col items-center justify-center gap-1 p-2'>
                        <Icon name='project-chat-doc-icon' width={28} height={28} color='var(--color-icon-base)' />
                        {item.name ? (
                          <span className='line-clamp-2 w-full text-center text-[11px] text-text-default-secondary'>
                            {item.name}
                          </span>
                        ) : null}
                      </div>
                    )}
                  </div>
                  {item.name && item.mediaType !== 'text' ? (
                    <div className='mt-1 truncate px-0.5 text-[11px] font-medium text-text-default-base'>
                      {item.name}
                    </div>
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

const MediaResourceListPanel = memo(MediaResourceListPanelComponent);
export default MediaResourceListPanel;
