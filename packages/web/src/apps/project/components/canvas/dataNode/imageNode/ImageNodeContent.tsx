/**
 * Image node content area: image + bottom-center fullscreen, download, @.
 * Style consistent with UploadedPanel / Generated.
 */
import React, { memo } from 'react';
import { cn } from '@/utils/classnames';
import { Image } from '@/components/base/image';
import { Icon } from '@/components/base/icon';

export interface ImageNodeContentProps {
  /** Image URL */
  src: string;
  /** `cursor` class for the image element; defaults to `cursor-grab`; Agent pick-mode target is `cursor-pointer` */
  imageCursorClassName?: string;
  /** Whether the node is selected; bottom toolbar is only shown when selected */
  selected?: boolean;
  /** Whether inside a locked/disabled group; bottom toolbar is hidden when true */
  isInsideLockedGroup?: boolean;
  /** Whether preview is open (controlled) */
  previewOpen?: boolean;
  /** Preview toggle callback */
  onPreviewChange?: (open: boolean) => void;
  /** Download click handler */
  onDownloadClick?: (e: React.MouseEvent) => void;
  /** @ mention click handler */
  onMentionClick?: (e: React.MouseEvent) => void;
  /** Image load complete, used to auto-fit node height */
  onImageLoad?: (naturalWidth: number, naturalHeight: number) => void;
  /**
   * Agent "pick image from canvas" focus state: when true, hides the bottom overlay (fullscreen/download/@) to avoid blocking the pick target
   */
  hideFloatingToolbar?: boolean;
}

const barClass = 'flex items-center gap-[2px] rounded-[4px] bg-white/80 p-[4px] shadow-sm nodrag';
const btnClass = 'flex h-[22px] w-[22px] items-center justify-center rounded-[4px] text-[#757575] hover:bg-black/5';

const ImageNodeContent: React.FC<ImageNodeContentProps> = ({
  src,
  selected = false,
  isInsideLockedGroup = false,
  previewOpen = false,
  onPreviewChange,
  onDownloadClick,
  onMentionClick,
  onImageLoad,
  imageCursorClassName = 'cursor-grab',
  hideFloatingToolbar = false,
}) => {
  const stopPropagation = (e: React.MouseEvent) => e.stopPropagation();

  const showBar = !hideFloatingToolbar && selected && !isInsideLockedGroup;

  return (
    <div className='relative flex h-full w-full min-h-0 items-center justify-center overflow-hidden rounded-[8px] group'>
      <div className='absolute inset-0 flex min-h-0 items-center justify-center overflow-hidden'>
        <Image
          src={src}
          alt='uploaded image'
          className='flex h-full w-full items-center justify-center'
          imgClassName={cn('h-full w-full object-cover', imageCursorClassName)}
          preview={{
            open: previewOpen,
            onOpenChange: onPreviewChange,
            previewOnClick: false,
          }}
          onLoad={(e) => onImageLoad?.(e.currentTarget.naturalWidth, e.currentTarget.naturalHeight)}
        />
      </div>
      {!hideFloatingToolbar ? (
        <div
          className={
            'absolute bottom-[15px] left-1/2 z-10 flex -translate-x-1/2 items-center justify-center gap-[4px] nodrag transition-opacity ' +
            (showBar ? 'opacity-100' : 'opacity-0')
          }
          onMouseDown={stopPropagation}
        >
          <div className={barClass}>
            <button
              type='button'
              onClick={(e) => {
                e.stopPropagation();
                onPreviewChange?.(true);
              }}
              className={btnClass}
              aria-label='Fullscreen'
            >
              <Icon name='project-chat-fullscreen-icon' width={12} height={12} color='#757575' />
            </button>
            <button
              type='button'
              onClick={(e) => {
                e.stopPropagation();
                onDownloadClick?.(e);
              }}
              className={btnClass}
              aria-label='Download'
            >
              <Icon name='project-chat-download-icon' width={20} height={20} color='#757575' />
            </button>
            <button
              type='button'
              onClick={(e) => {
                e.stopPropagation();
                onMentionClick?.(e);
              }}
              className={btnClass}
              aria-label='Mention'
            >
              <Icon name='project-chat-mention-icon' width={15} height={15} color='#757575' />
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
};

export default memo(ImageNodeContent);
