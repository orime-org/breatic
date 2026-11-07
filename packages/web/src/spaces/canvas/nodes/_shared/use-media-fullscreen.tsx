// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import * as React from 'react';

import { MediaFullscreen, type MediaFullscreenSource } from '@web/spaces/canvas/nodes/_shared/MediaFullscreen';
import type { MediaPlayerHandle } from '@web/spaces/canvas/nodes/_shared/MediaPlayer';
import type { MediaPlayerState } from '@web/spaces/canvas/nodes/_shared/use-media-player';

/** What a host hands {@link useMediaFullscreen}. */
interface MediaFullscreenHost {
  /** The file's name, for the dialog's title. */
  name: string;
  /** What the host shows now: the place goes back only while it still does. */
  currentSrc: string | undefined;
  /** The host's own player, paused as full screen opens and handed its place back. */
  player?: React.RefObject<MediaPlayerHandle | null>;
  /** The content's id, for a host that points at it. */
  id?: string;
  /** Where the focus goes as it closes. */
  onCloseAutoFocus?: (event: Event) => void;
}

/** What full screen opened on. */
interface Opened extends MediaFullscreenSource {
  start?: MediaPlayerState;
}

/** What {@link useMediaFullscreen} gives its host. */
interface MediaFullscreenControl {
  /** Opens full screen on this media. */
  open: (source: MediaFullscreenSource) => void;
  /** Whether it is open. */
  isOpen: boolean;
  /** The layer, mounted only while open; render it anywhere in the host. */
  layer: React.ReactNode;
}

/**
 * Full screen for one host's image or video (inner#1844). It opens on what
 * the host shows at that moment and keeps it while the host changes, so a
 * result landing on a node does not swap what is being watched. One player
 * sounds at a time: the host's pauses, and takes back the full screen's place
 * and sound when it closes, if it still holds the same file.
 * @param host - The host.
 * @param host.name - The file's name.
 * @param host.currentSrc - What the host shows now.
 * @param host.player - The host's own player.
 * @param host.id - The content's id.
 * @param host.onCloseAutoFocus - Where the focus goes as it closes.
 * @returns How to open it and the layer to render.
 */
export function useMediaFullscreen({
  name,
  currentSrc,
  player,
  id,
  onCloseAutoFocus,
}: MediaFullscreenHost): MediaFullscreenControl {
  const [opened, setOpened] = React.useState<Opened | null>(null);

  const open = React.useCallback(
    (source: MediaFullscreenSource): void => {
      const handle = player?.current ?? null;
      setOpened({ ...source, start: source.kind === 'video' ? handle?.read() : undefined });
      handle?.pause();
    },
    [player],
  );

  const layer = opened ? (
    <MediaFullscreen
      onClose={(state) => {
        setOpened(null);
        if (state && opened.src === currentSrc) player?.current?.apply(state);
      }}
      kind={opened.kind}
      src={opened.src}
      poster={opened.poster}
      size={opened.size}
      start={opened.start}
      name={name}
      id={id}
      onCloseAutoFocus={onCloseAutoFocus}
    />
  ) : null;

  return { open, isOpen: opened !== null, layer };
}
