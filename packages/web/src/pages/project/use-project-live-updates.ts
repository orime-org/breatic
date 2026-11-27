// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import { useCallback, useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { HocuspocusProvider } from '@hocuspocus/provider';
import {
  ASSET_PEAKS_READY_SIGNAL,
  NOTIFICATIONS_CHANGED_SIGNAL,
  PROJECT_TRANSFER_CHANGED_SIGNAL,
  UPLOAD_ENDED_SIGNAL,
  VIDEO_PRESENTATION_CHANGED_SIGNAL,
  type UploadStatus,
} from '@breatic/shared';

import { settleUploadEnding } from '@web/data/upload/upload-status';
import { useProjectSignal } from '@web/pages/project/use-project-signal';
import { announceAudioPeaksReady } from '@web/spaces/canvas/mini-tool/audio-peaks-ready';
import { videoPresentationQueryKey } from '@web/spaces/canvas/video-presentation/video-presentation-query';

/**
 * Act on what collab says changed behind the Project page (#1580): read the bell or the project's transfer again,
 * hand an upload's ending to whoever waits for it, tell the cut bands a waveform is ready, and read a video's
 * presentation again when what users see of it changed (frames-split §7.20). The page asks the
 * server again only on these messages, never on a timer.
 * @param projectId - The project being viewed.
 * @param provider - The live meta-doc provider, or null while there is none.
 */
export function useProjectLiveUpdates(
  projectId: string,
  provider: Pick<HocuspocusProvider, 'on' | 'off'> | null | undefined,
): void {
  const queryClient = useQueryClient();
  const readBell = useCallback((): void => {
    void queryClient.invalidateQueries({ queryKey: ['notifications', 'unread'] });
  }, [queryClient]);
  const readTransfer = useCallback((): void => {
    void queryClient.invalidateQueries({ queryKey: ['project-transfer', 'live', projectId] });
  }, [queryClient, projectId]);

  useProjectSignal(provider, null, NOTIFICATIONS_CHANGED_SIGNAL, readBell);
  useProjectSignal(provider, projectId, PROJECT_TRANSFER_CHANGED_SIGNAL, readTransfer);

  useEffect(() => {
    if (!provider) return;
    /**
     * Hand each upload's ending, each ready waveform and each presentation change on at once, one message at a time.
     * @param data - The stateless message wrapper.
     * @param data.payload - Raw stateless string payload.
     */
    const onStateless = (data: { payload: string }): void => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(data.payload);
      } catch {
        // Non-JSON stateless traffic (e.g. space RPC responses) — not ours.
        return;
      }
      const message = (parsed ?? {}) as { t?: unknown; status?: unknown; url?: unknown; projectId?: unknown };
      if (message.t === UPLOAD_ENDED_SIGNAL && typeof message.status === 'object' && message.status !== null) {
        settleUploadEnding(message.status as UploadStatus);
      } else if (message.t === ASSET_PEAKS_READY_SIGNAL && typeof message.url === 'string') {
        announceAudioPeaksReady(message.url);
      } else if (message.t === VIDEO_PRESENTATION_CHANGED_SIGNAL && message.projectId === projectId && typeof message.url === 'string') {
        void queryClient.invalidateQueries({ queryKey: videoPresentationQueryKey(projectId, message.url) });
      }
    };
    provider.on('stateless', onStateless);
    return (): void => {
      provider.off('stateless', onStateless);
    };
  }, [provider, projectId, queryClient]);
}
