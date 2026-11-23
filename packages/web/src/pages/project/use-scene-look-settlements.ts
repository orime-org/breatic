// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { HocuspocusProvider } from '@hocuspocus/provider';
import { SCENE_LOOK_PICTURE_SETTLEMENTS, SCENE_LOOK_SETTLED_SIGNAL, type SceneLookSettledSignal } from '@breatic/shared';
import { pageSceneLookUploads } from '@web/spaces/three-d/scene-look-uploads';

const OUTCOMES: ReadonlySet<string> = new Set(SCENE_LOOK_PICTURE_SETTLEMENTS);

/**
 * Whether a stateless payload settles a part picture this user uploaded in this project.
 * @param value - The parsed payload.
 * @param projectId - The project.
 * @param userId - This user.
 * @returns True for such a settlement.
 */
function isOwnSettlement(value: unknown, projectId: string, userId: string): value is SceneLookSettledSignal {
  const signal = (value ?? {}) as Partial<Record<keyof SceneLookSettledSignal, unknown>>;
  return signal.t === SCENE_LOOK_SETTLED_SIGNAL && signal.projectId === projectId && signal.userId === userId
    && typeof signal.spaceId === 'string' && typeof signal.objectId === 'string' && typeof signal.part === 'string'
    && typeof signal.picture === 'string' && typeof signal.outcome === 'string' && OUTCOMES.has(signal.outcome);
}

/**
 * Hand this user how collab settled each part picture they uploaded (inner#1693 design 6.3): the meta-doc socket carries
 * collab's settlement, and the page's uploads end that part's upload, telling the user why when it was not put on.
 * @param projectId - The project whose signals count.
 * @param provider - The live meta-doc provider, or null while there is none.
 * @param userId - This user, or undefined before it is known.
 */
export function useSceneLookSettlements(
  projectId: string,
  provider: Pick<HocuspocusProvider, 'on' | 'off'> | null | undefined,
  userId: string | undefined,
): void {
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!provider || userId === undefined) return;
    const uploads = pageSceneLookUploads(queryClient);
    /**
     * Parse a stateless payload and hand this user's settlement to the uploads.
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
      if (!isOwnSettlement(parsed, projectId, userId)) return;
      const { spaceId, objectId, part, picture, outcome } = parsed;
      uploads.settled({ spaceId, objectId, part, picture, outcome });
    };
    provider.on('stateless', onStateless);
    return (): void => { provider.off('stateless', onStateless); };
  }, [provider, projectId, userId, queryClient]);
}
