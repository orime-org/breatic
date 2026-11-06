// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import * as React from 'react';
import { X } from 'lucide-react';

import { Dialog, DialogClose, DialogContent, DialogTitle } from '@web/components/ui/dialog';
import { Skeleton } from '@web/components/ui/skeleton';
import { useTranslation } from '@web/i18n/use-translation';
import { takeStray } from '@web/lib/stray-file-drop';
import { cn } from '@web/lib/utils';
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
  /** The media's own size when known; the box is reserved from it before it loads. */
  size?: { width: number; height: number };
}

/** Props for {@link MediaFullscreen}. */
interface MediaFullscreenProps extends MediaFullscreenSource {
  /** Closes it, with where a video stood. */
  onClose: (state?: MediaPlayerState) => void;
  /** The file's name, for the dialog's title. */
  name: string;
  /** The content's id, for a host that points at it. */
  id?: string;
  /** Where a video starts. */
  start?: MediaPlayerState;
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
 * Stops a file drag from reaching the host, and cancels the browser's own
 * opening of the file: the window's stray-file guard never sees it now.
 * @param event - A `dragover` or a `drop`.
 */
function stopDrop(event: React.DragEvent): void {
  event.stopPropagation();
  takeStray(event.nativeEvent);
}

/**
 * The one full-screen view for images and videos (inner#1844): the media
 * centred on a dark backdrop, a close button at the viewport's top-right, Esc
 * and a press on the backdrop closing it.
 *
 * Hosts mount it only while open (`useMediaFullscreen`), so each opening
 * starts fresh.
 *
 * Press events are left to bubble: Radix tells a press outside a layer from a
 * document listener in the bubble phase, which the backdrop close and the
 * volume popover rely on, and no host answers presses.
 * @param root0 - Component props.
 * @param root0.onClose - Closes it, with where a video stood.
 * @param root0.kind - Image or video.
 * @param root0.src - The original file.
 * @param root0.poster - A video's cover.
 * @param root0.name - The file's name, for the dialog's title.
 * @param root0.size - The media's own size when known.
 * @param root0.id - The content's id.
 * @param root0.start - Where a video starts.
 * @param root0.onCloseAutoFocus - Where the focus goes as it closes.
 * @returns The view.
 */
export function MediaFullscreen({
  onClose,
  kind,
  src,
  poster,
  name,
  size,
  id,
  start,
  onCloseAutoFocus,
}: MediaFullscreenProps): React.JSX.Element {
  const t = useTranslation();
  const player = React.useRef<MediaPlayerHandle>(null);
  const [image, setImage] = React.useState<'loading' | 'loaded' | 'failed'>('loading');

  // One sizing rule for images and videos: as wide as fits the viewport at
  // the media's own shape, so a tall one is held to the viewport's height and
  // a video's bar is as wide as its picture. With the shape known the box is
  // there before the file arrives; a video of unknown size has it from its
  // own metadata. A picture is never shown wider than it is. A picture that
  // failed gives the box back: the error sits centred on the backdrop.
  const [measured, setMeasured] = React.useState<{ width: number; height: number } | undefined>(undefined);
  const box = image === 'failed' ? undefined : (size ?? measured);
  const boxStyle = box
    ? ({
      '--media-aspect': box.width / box.height,
      ...(kind === 'image' && { '--media-width': `${box.width}px` }),
    } as React.CSSProperties)
    : undefined;

  return (
    // Not a control: it only keeps the layer's events from its host. A span,
    // because a hover preview hosts it inside a line of text.
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions
    <span
      className='contents'
      onClick={stop}
      onDoubleClick={stop}
      onContextMenu={stop}
      onKeyDown={stop}
      onDragEnter={stop}
      onDragOver={stopDrop}
      onDrop={stopDrop}
    >
      <Dialog
        open
        onOpenChange={(next) => {
          if (!next) onClose(player.current?.read());
        }}
      >
        <DialogContent
          id={id}
          data-testid='media-fullscreen'
          aria-describedby={undefined}
          onCloseAutoFocus={onCloseAutoFocus}
          // No entry zoom: a transform on the content would hold the fixed
          // close button to the content's box until the animation ends.
          className={cn(
            'max-w-[min(96vw,1600px)] items-center border-0 bg-transparent shadow-none data-[state=closed]:animate-none data-[state=open]:animate-none',
            // As wide as the media, so the dark either side is backdrop and a press there closes.
            kind === 'image' && !box ? 'w-fit' : 'w-[min(96vw,1600px,calc(90vh*var(--media-aspect,100)),var(--media-width,100vw))]',
          )}
          style={boxStyle}
        >
          <DialogTitle className='sr-only'>{name}</DialogTitle>
          {kind === 'image' ? (
            <div className={cn('relative', box ? 'aspect-[var(--media-aspect)] w-full' : image === 'loading' && 'min-h-40 min-w-40')}>
              {image === 'failed' ? (
                <p data-testid='media-fullscreen-error' className='px-4 py-8 text-sm text-white'>
                  {t('common.mediaViewer.loadFailed')}
                </p>
              ) : null}
              <img
                src={src}
                alt=''
                draggable={false}
                data-testid='media-fullscreen-image'
                onLoad={() => setImage('loaded')}
                onError={() => setImage('failed')}
                className={image === 'failed' ? 'hidden' : box ? 'h-full w-full object-contain' : 'h-auto max-h-[90vh] w-auto max-w-full object-contain'}
              />
              {image === 'loading' ? (
                <Skeleton data-testid='media-fullscreen-skeleton' className='absolute inset-0' />
              ) : null}
            </div>
          ) : (
            <div className='w-full [&_video]:max-h-[90vh]'>
              <MediaPlayer ref={player} modality='video' src={src} poster={poster} fullPoster size={size} start={start} onDimensions={setMeasured} />
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
    </span>
  );
}
