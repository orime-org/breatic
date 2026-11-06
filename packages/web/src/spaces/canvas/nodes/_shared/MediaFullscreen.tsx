// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import * as React from 'react';
import { X } from 'lucide-react';

import { Dialog, DialogClose, DialogContent, DialogTitle } from '@web/components/ui/dialog';
import { Skeleton } from '@web/components/ui/skeleton';
import { useTranslation } from '@web/i18n/use-translation';
import { MediaPlayer, type MediaPlayerHandle } from '@web/spaces/canvas/nodes/_shared/MediaPlayer';
import type { MediaPlayerState } from '@web/spaces/canvas/nodes/_shared/use-media-player';

/** What a full-screen view shows. */
export interface MediaFullscreenSource {
  /** Image or video. */
  kind: 'image' | 'video';
  /** The original file. */
  src: string;
  /** A video's cover. */
  poster?: string;
}

/** Props for {@link MediaFullscreen}. */
interface MediaFullscreenProps extends MediaFullscreenSource {
  /** Whether it is open. */
  open: boolean;
  /** Opens or closes it. */
  onOpenChange: (open: boolean) => void;
  /** The file's name, for the dialog's title. */
  name: string;
  /** The media's own size when known; the box is reserved from it before it loads. */
  size?: { width: number; height: number };
  /** The content's id, for a host that points at it. */
  id?: string;
  /** Where a video starts. */
  start?: MediaPlayerState;
  /** Where the video stood as it closed. */
  onClosed?: (state: MediaPlayerState) => void;
  /** Where the focus goes as it closes. */
  onCloseAutoFocus?: (event: Event) => void;
}

/**
 * Stops a React event from reaching the host. React events cross the portal
 * back up the component tree, and a canvas node answers clicks, keys, the
 * context menu and file drops of its own.
 * @param event - The event.
 */
function stop(event: React.SyntheticEvent): void {
  event.stopPropagation();
}

/**
 * The one full-screen view for images and videos (inner#1844): the media
 * centred on a dark backdrop, a close button at the viewport's top-right, Esc
 * and a press on the backdrop closing it.
 *
 * Press events are left to bubble: Radix tells a press outside a layer from a
 * document listener in the bubble phase, which the backdrop close and the
 * volume popover rely on, and no host answers presses.
 * @param root0 - Component props.
 * @param root0.open - Whether it is open.
 * @param root0.onOpenChange - Opens or closes it.
 * @param root0.kind - Image or video.
 * @param root0.src - The original file.
 * @param root0.poster - A video's cover.
 * @param root0.name - The file's name, for the dialog's title.
 * @param root0.size - The media's own size when known.
 * @param root0.id - The content's id.
 * @param root0.start - Where a video starts.
 * @param root0.onClosed - Where the video stood as it closed.
 * @param root0.onCloseAutoFocus - Where the focus goes as it closes.
 * @returns The view.
 */
export function MediaFullscreen({
  open,
  onOpenChange,
  kind,
  src,
  poster,
  name,
  size,
  id,
  start,
  onClosed,
  onCloseAutoFocus,
}: MediaFullscreenProps): React.JSX.Element {
  const t = useTranslation();
  const player = React.useRef<MediaPlayerHandle>(null);
  const [settled, setSettled] = React.useState<{ src: string; loaded: boolean } | null>(null);
  const image = settled?.src !== src ? 'loading' : settled.loaded ? 'loaded' : 'failed';

  /**
   * Hands the video's state back before the layer closes.
   * @param next - Whether it is to be open.
   */
  const change = (next: boolean): void => {
    if (!next && player.current) onClosed?.(player.current.read());
    onOpenChange(next);
  };

  // A tall video is held to the viewport's height by its width.
  const videoWidth = size ? `min(96vw, 1600px, calc(90vh * ${size.width} / ${size.height}))` : 'min(96vw, 1600px)';

  return (
    // Not a control: it only keeps the layer's events from its host.
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions
    <div
      className='contents'
      onClick={stop}
      onDoubleClick={stop}
      onContextMenu={stop}
      onKeyDown={stop}
      onDragEnter={stop}
      onDragOver={stop}
      onDrop={stop}
    >
      <Dialog open={open} onOpenChange={change}>
        <DialogContent
          id={id}
          data-testid='media-fullscreen'
          aria-describedby={undefined}
          onCloseAutoFocus={onCloseAutoFocus}
          // No entry zoom: a transform on the content would hold the fixed
          // close button to the content's box until the animation ends.
          className='max-w-[min(96vw,1600px)] items-center border-0 bg-transparent shadow-none data-[state=closed]:animate-none data-[state=open]:animate-none'
          style={kind === 'video' ? { width: videoWidth } : undefined}
        >
          <DialogTitle className='sr-only'>{name}</DialogTitle>
          {kind === 'image' ? (
            <div className='relative'>
              {image === 'failed' ? (
                <p data-testid='media-fullscreen-error' className='px-4 py-8 text-sm text-white'>
                  {t('common.mediaViewer.loadFailed')}
                </p>
              ) : null}
              <img
                src={src}
                alt=''
                draggable={false}
                width={size?.width}
                height={size?.height}
                data-testid='media-fullscreen-image'
                onLoad={() => setSettled({ src, loaded: true })}
                onError={() => setSettled({ src, loaded: false })}
                className={image === 'failed' ? 'hidden' : 'h-auto max-h-[90vh] w-auto max-w-full object-contain'}
              />
              {image === 'loading' ? (
                <Skeleton data-testid='media-fullscreen-skeleton' className='absolute inset-0 min-h-40 min-w-40' />
              ) : null}
            </div>
          ) : (
            <div className='w-full [&_video]:max-h-[90vh]'>
              <MediaPlayer ref={player} modality='video' src={src} poster={poster} size={size} start={start} />
            </div>
          )}
          <DialogClose
            data-testid='media-fullscreen-close'
            aria-label={t('common.mediaViewer.close')}
            className='fixed right-4 top-4 inline-flex h-[var(--btn-chrome)] w-[var(--btn-chrome)] items-center justify-center rounded-chrome text-white transition-colors hover:bg-white/15 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white'
          >
            <X className='h-[18px] w-[18px]' />
          </DialogClose>
        </DialogContent>
      </Dialog>
    </div>
  );
}
