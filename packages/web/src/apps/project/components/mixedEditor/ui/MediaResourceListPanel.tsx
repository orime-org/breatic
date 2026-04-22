import React, { memo } from 'react';
import { cn } from '@/utils/classnames';
import { Icon } from '@/components/base/icon';
import { Image } from '@/components/base/image';

/**
 * One image row: preview URL, optional display name (image editor side panels are image-only).
 */
export type MediaResourceListItem = {
  id: string;
  previewUrl: string;
  name?: string;
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
  onItemAddClick?: (item: MediaResourceListItem) => void;
  /** Same hover bar as {@link MediaResourceListPanelProps.onItemAddClick}. */
  onItemDownloadClick?: (item: MediaResourceListItem) => void;
  /** When set with {@link MediaResourceListPanelProps.onItemFavoriteClick}, shows a star control on the top-right of each row. */
  isItemFavorited?: (item: MediaResourceListItem) => boolean;
  /** Toggle favorite; parent updates list (e.g. Redux) and {@link MediaResourceListPanelProps.isItemFavorited} reflects state. */
  onItemFavoriteClick?: (item: MediaResourceListItem) => void;
  className?: string;
};

const itemThumbClass = 'relative aspect-square w-full overflow-hidden rounded-[8px] border border-[var(--color-border-default-base)] bg-[var(--color-background-default-secondary)]';

/** Matches `ImageNodeContent` floating bar (`barClass` / `btnClass`). */
const itemHoverBarClass = 'flex items-center gap-[2px] rounded-[4px] bg-white/80 p-[4px] shadow-sm';
const itemHoverBtnClass = 'flex h-[22px] w-[22px] items-center justify-center rounded-[4px] text-[#757575] hover:bg-black/5';
const itemFavoriteBtnClass = 'absolute right-1 top-1 z-20 flex h-[22px] w-[22px] items-center justify-center rounded-[4px] bg-white/85 shadow-sm transition-colors hover:bg-white';

type MediaResourceListThumbProps = {
  item: MediaResourceListItem;
};

/**
 * Square image preview using the same `Image` component as the canvas / composer.
 */
const MediaResourceListThumb = memo(function MediaResourceListThumb({ item }: MediaResourceListThumbProps) {
  if (!item.previewUrl) {
    return (
      <div className='flex h-full w-full items-center justify-center'>
        <Icon name='project-image-editor-right-assets-icon' width={28} height={28} color='var(--color-icon-base)' />
      </div>
    );
  }
  return (
    <Image
      src={item.previewUrl}
      alt={item.name ?? ''}
      preview={false}
      lazy
      className='flex h-full w-full min-h-0 items-center justify-center'
      imgClassName='h-full w-full object-cover'
    />
  );
});

/**
 * Flyout list panel for image rows only. Data-driven; callers supply `items`.
 *
 * @param props.open - Visibility.
 * @param props.title - Header label.
 * @param props.items - Rows to render.
 * @param props.onClose - Close control (header X).
 */
function MediaResourceListPanelComponent({
  open,
  title,
  showStatusDot = false,
  onClose,
  items,
  emptyText = 'No items',
  onItemAddClick,
  onItemDownloadClick,
  isItemFavorited,
  onItemFavoriteClick,
  className,
}: MediaResourceListPanelProps) {
  if (!open) return null;

  return (
    <div
      className={cn(
        'flex h-[70%] min-h-[120px] w-[200px] min-w-0 shrink-0 flex-col overflow-hidden rounded-[8px] border border-[var(--color-border-default-base)] bg-background-default-base shadow-[0px_4px_16px_-1px_rgba(12,12,13,0.08),0px_2px_8px_-1px_rgba(12,12,13,0.06)]',
        className,
      )}
      role='dialog'
      aria-label={title}
    >
      <div className='flex shrink-0 items-center justify-between gap-2 px-[10px] pt-[10px] pb-0'>
        <div className='flex min-w-0 items-center gap-2'>
          {showStatusDot ? (
            <span className='h-2 w-2 shrink-0 rounded-full bg-[#2FB344]' aria-hidden />
          ) : null}
          <span className='truncate text-sm font-semibold text-text-default-base'>{title}</span>
        </div>
        <button
          type='button'
          className='flex h-7 w-7 shrink-0 items-center justify-center rounded-[8px] text-icon-base transition-colors hover:bg-background-default-base-hover'
          aria-label='Close'
          onClick={onClose}
        >
          <Icon name='base-close-icon' width={14} height={14} />
        </button>
      </div>

      <div className='min-h-0 flex-1 overflow-y-auto px-[10px] pb-[10px] pt-0'>
        {items.length === 0 ? (
          <div className='py-6 text-center text-xs text-text-default-tertiary'>{emptyText}</div>
        ) : (
          <ul className='flex flex-col gap-2'>
            {items.map((item) => {
              const showHoverActions = Boolean(onItemAddClick || onItemDownloadClick);
              const favorited = isItemFavorited?.(item) ?? false;
              return (
                <li key={item.id} className='group w-full'>
                  <div className='relative w-full'>
                    <div className={cn(itemThumbClass, 'text-left')}>
                      <MediaResourceListThumb item={item} />
                    </div>
                    {onItemFavoriteClick ? (
                      <button
                        type='button'
                        className={itemFavoriteBtnClass}
                        aria-label={favorited ? 'Remove from favorites' : 'Add to favorites'}
                        aria-pressed={favorited}
                        onClick={(e) => {
                          e.stopPropagation();
                          onItemFavoriteClick(item);
                        }}
                        onMouseDown={(e) => e.stopPropagation()}
                      >
                        <Icon
                          name='project-image-editor-media-favorite-icon'
                          width={13}
                          height={13}
                          color={favorited ? '#E8A317' : '#757575'}
                          className={cn(!favorited && 'opacity-55')}
                        />
                      </button>
                    ) : null}
                    {showHoverActions ? (
                      <div
                        className={cn(
                          'pointer-events-none absolute bottom-2 left-1/2 z-10 flex -translate-x-1/2 items-center justify-center transition-opacity duration-150',
                          'opacity-0 group-hover:pointer-events-auto group-hover:opacity-100',
                          'group-focus-within:pointer-events-auto group-focus-within:opacity-100',
                        )}
                      >
                        <div
                          className={cn(itemHoverBarClass, 'pointer-events-auto')}
                          onMouseDown={(e) => e.stopPropagation()}
                        >
                          {onItemAddClick ? (
                            <button
                              type='button'
                              className={itemHoverBtnClass}
                              aria-label='Add'
                              onClick={(e) => {
                                e.stopPropagation();
                                onItemAddClick(item);
                              }}
                            >
                              <Icon name='project-plus-icon' width={14} height={14} color='#757575' />
                            </button>
                          ) : null}
                          {onItemDownloadClick ? (
                            <button
                              type='button'
                              className={itemHoverBtnClass}
                              aria-label='Download'
                              onClick={(e) => {
                                e.stopPropagation();
                                onItemDownloadClick(item);
                              }}
                            >
                              <Icon name='project-chat-download-icon' width={20} height={20} color='#757575' />
                            </button>
                          ) : null}
                        </div>
                      </div>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

const MediaResourceListPanel = memo(MediaResourceListPanelComponent);
export default MediaResourceListPanel;
