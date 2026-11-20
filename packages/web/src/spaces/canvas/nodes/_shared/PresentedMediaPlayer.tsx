// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The media player of a watch-only video surface (Document video block, hover preview; frames-split design §7.8 surface
 * list, §7.9 last paragraph): it reads the same presentation query Qp as the canvas node, plays the selected version's
 * playback file once there is one, and the original for display until then, with the preparing or failed state over it.
 */

import * as React from 'react';
import { useResolvedVideoPresentation } from '@web/spaces/canvas/video-presentation/use-resolved-video-presentation';
import { useVideoPresentationRepair } from '@web/spaces/canvas/video-presentation/video-presentation-recovery';
import { MediaPlayer, type MediaPlayerProps } from '@web/spaces/canvas/nodes/_shared/MediaPlayer';

/** A video player's props plus the Project whose source it reads. */
export interface PresentedMediaPlayerProps extends Omit<MediaPlayerProps, 'modality' | 'videoSource' | 'preparation'> {
  projectId: string;
  /** Whether a temporary candidate failure offers Retry; a hover preview shows only the reason. */
  retry?: boolean;
}

/**
 * Plays one registered video through Qp.
 * @param props - The player props, the Project and whether Retry is offered.
 * @param props.projectId - The Project whose source is read.
 * @param props.retry - Whether a temporary candidate failure offers Retry.
 * @returns The player.
 * @throws {never} Read failures stay in the query state.
 */
export function PresentedMediaPlayer({ projectId, retry = true, ...player }: PresentedMediaPlayerProps): React.JSX.Element {
  const { source, failure } = useResolvedVideoPresentation(projectId, player.src, player.active ?? true);
  const { repair, repairing } = useVideoPresentationRepair(projectId);
  const { src } = player;
  const onRetry = React.useCallback((): void => repair(src), [repair, src]);
  const busy = repairing.has(src);
  const preparation = React.useMemo(() => ({ failure: source === null ? failure : null, ...(retry ? { onRetry, retrying: busy } : {}) }), [source, failure, retry, onRetry, busy]);
  return <MediaPlayer {...player} modality='video' videoSource={source} preparation={preparation} />;
}
