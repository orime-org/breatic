// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { HocuspocusProvider } from '@hocuspocus/provider';
import { SCENE_LOOK_REFUSED_SIGNAL, type SceneLookRefusedSignal } from '@breatic/shared';
import { pageSceneLookUploads } from '@web/spaces/three-d/scene-look-uploads';

/** The reasons collab gives for not writing a part picture. */
const REASONS: ReadonlySet<string> = new Set(['objectGone', 'partChanged', 'partLimit']);

/**
 * Whether a stateless payload is a refusal of a part picture this user uploaded in this project.
 * @param value - The parsed payload.
 * @param projectId - The project.
 * @param userId - This user.
 * @returns True for such a refusal.
 */
function isOwnRefusal(value: unknown, projectId: string, userId: string): value is SceneLookRefusedSignal {
  const signal = (value ?? {}) as Partial<Record<keyof SceneLookRefusedSignal, unknown>>;
  return signal.t === SCENE_LOOK_REFUSED_SIGNAL && signal.projectId === projectId && signal.userId === userId
    && typeof signal.spaceId === 'string' && typeof signal.objectId === 'string' && typeof signal.part === 'string'
    && typeof signal.picture === 'string' && typeof signal.reason === 'string' && REASONS.has(signal.reason);
}

/**
 * Tell this user why collab did not put a part picture they uploaded on its part (inner#1693 design 6.3): the meta-doc
 * socket carries collab's refusal, and the page's uploads end that part's wait with the reason.
 * @param projectId - The project whose signals count.
 * @param provider - The live meta-doc provider, or null while there is none.
 * @param userId - This user, or undefined before it is known.
 */
export function useSceneLookRefusals(
  projectId: string,
  provider: Pick<HocuspocusProvider, 'on' | 'off'> | null | undefined,
  userId: string | undefined,
): void {
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!provider || userId === undefined) return;
    const uploads = pageSceneLookUploads(queryClient);
    /**
     * Parse a stateless payload and hand this user's refusal to the uploads.
     * @param data - The stateless message wrapper.
     * @param data.payload - Raw stateless string payload.
     */
    const onStateless = (data: { payload: string }): void => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(data.payload);
      } catch {
        // Non-JSON stateless traffic (space RPC answers) is not this signal.
        return;
      }
      if (!isOwnRefusal(parsed, projectId, userId)) return;
      const { spaceId, objectId, part, picture, reason } = parsed;
      uploads.refused({ spaceId, objectId, part, picture, reason });
    };
    provider.on('stateless', onStateless);
    return (): void => { provider.off('stateless', onStateless); };
  }, [provider, projectId, userId, queryClient]);
}
