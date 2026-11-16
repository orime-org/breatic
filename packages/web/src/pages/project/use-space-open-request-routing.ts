// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import * as React from 'react';

import type { ProjectSpace } from '@web/data/yjs/project-meta';
import { useTranslation } from '@web/i18n/use-translation';
import { toast } from '@web/lib/toast';
import { useSpaceOpenRequestStore, type SpaceOpenRequestEffect, type SpaceOpenRequestEvent } from '@web/stores/space-open-request';

/**
 * The newest Space of a type, by when it was made.
 * @param spaces - The project's Spaces.
 * @param type - The type.
 * @returns It, or undefined.
 * @throws {never} Never.
 */
function newestOf(spaces: readonly ProjectSpace[], type: ProjectSpace['type']): ProjectSpace | undefined {
  return spaces.filter((space) => space.type === type).reduce<ProjectSpace | undefined>(
    (newest, space) => (newest === undefined || (space.createdAt ?? 0) >= (newest.createdAt ?? 0) ? space : newest), undefined);
}

/**
 * Carry out the open-or-make requests of the Space-open store (#1490 design §8.5, §13.5): open the named Space, or the
 * newest of its type, or make one named as the backend names it and open it. The page reports the made Space through
 * `created`; the Space that opened says it handled the request. Judged only once the project's Spaces have arrived.
 * @param spaces - The project's Spaces.
 * @param activeId - The Space in front.
 * @param ready - Whether the project's Spaces have arrived.
 * @param open - Opens a Space's tab, or switches to it.
 * @param create - Makes a Space of a type with a name.
 * @returns How to tell the store a Space was made, or making one failed.
 * @throws {never} Never.
 */
export function useSpaceOpenRequestRouting(
  spaces: readonly ProjectSpace[],
  activeId: string | null,
  ready: boolean,
  open: (spaceId: string) => void,
  create: (type: ProjectSpace['type'], name: string) => Promise<void>,
): { created: (spaceId: string) => void; createFailed: () => void } {
  const t = useTranslation();
  const state = useSpaceOpenRequestStore((store) => store.state);
  const run = React.useCallback(function run(event: SpaceOpenRequestEvent): void {
    for (const effect of useSpaceOpenRequestStore.getState().dispatch(event) as SpaceOpenRequestEffect[]) {
      if (effect.type === 'open_tab') open(effect.spaceId);
      if (effect.type === 'toast_source_space_gone') toast.warning(t('spaces.webAnimation.sourceSpaceGone'));
      // A refused create has said why through the page's own create failure.
      if (effect.type === 'create') void create(effect.spaceType, effect.name).catch(() => run({ type: 'create_failed' }));
    }
  }, [open, create, t]);
  React.useEffect(() => {
    if (!ready || state.status !== 'requesting') return;
    const { request } = state;
    if (request.spaceId !== undefined) {
      const named = spaces.find((space) => space.id === request.spaceId);
      run(named?.type === request.type ? { type: 'target_exists', spaceId: named.id } : { type: 'target_gone' });
      return;
    }
    const newest = newestOf(spaces, request.type);
    run(newest === undefined ? { type: 'target_missing' } : { type: 'target_exists', spaceId: newest.id });
  }, [ready, state, spaces, run]);
  // Leaving the Space a request opened before it took the request ends the request.
  const front = React.useRef(false);
  React.useEffect(() => {
    if (state.status !== 'opened') { front.current = false; return; }
    if (activeId === state.spaceId) front.current = true;
    else if (front.current) run({ type: 'leave' });
  }, [state, activeId, run]);
  // The page that resolves requests and reports a made Space is going away: what it left pending can never finish.
  React.useEffect(() => () => { useSpaceOpenRequestStore.getState().dispatch({ type: 'reset' }); }, []);
  const created = React.useCallback((spaceId: string): void => {
    if (useSpaceOpenRequestStore.getState().state.status === 'creating') run({ type: 'created', spaceId });
  }, [run]);
  const createFailed = React.useCallback((): void => {
    if (useSpaceOpenRequestStore.getState().state.status === 'creating') run({ type: 'create_failed' });
  }, [run]);
  return React.useMemo(() => ({ created, createFailed }), [created, createFailed]);
}
