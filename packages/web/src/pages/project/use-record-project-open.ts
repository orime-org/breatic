// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import * as React from 'react';
import { useQueryClient } from '@tanstack/react-query';

import { isStudioProjectsListKey } from '@web/data/api/projects';
import {
  ProjectVisit,
  type ProjectVisitAccountSource,
  type ProjectVisitHandle,
} from '@web/pages/project/project-visit';

/** Identity of the current route activation, independent of its data providers. */
export interface ProjectVisitScope {
  accountId: string | null;
  navigationKey: string;
  /** The production auth store; optional for callers that supply their own scope. */
  accountSource?: ProjectVisitAccountSource;
}

/**
 * Own one live visit above project queries and providers. Effect replay and
 * temporary loading gates reuse it; each actual navigation or bfcache restore
 * allocates a fresh identity, including Back to a previously used location key.
 * @param projectId - Bare project UUID.
 * @param enabled - Whether the page has loaded an accessible project.
 * @param scope - Current account and router activation, with a live auth source.
 * @returns The live original result, also readable after this entry ends.
 * @throws {never} Transport and protocol failures stay in the visit handle.
 */
export function useRecordProjectOpen(
  projectId: string,
  enabled: boolean,
  scope: ProjectVisitScope,
): ProjectVisitHandle {
  const queryClient = useQueryClient();
  const [, notify] = React.useReducer((version: number) => version + 1, 0);
  const [restoration, setRestoration] = React.useState(0);
  const accountSource = scope.accountSource;
  const accountGeneration = accountSource?.getGeneration?.();
  // A fresh account token is committed in layout, so an abandoned concurrent
  // render cannot retire the still-mounted entry's account ownership.
  const accountEpoch = React.useMemo(() => ({
    accountId: scope.accountId, accountGeneration,
  }), [scope.accountId, accountGeneration]);
  const owner = React.useRef({ epoch: accountEpoch, listeners: new Set<() => void>() });
  const activation = React.useMemo(() => ({
    projectId, accountId: scope.accountId, navigationKey: scope.navigationKey, restoration,
  }), [projectId, scope.accountId, scope.navigationKey, restoration]);
  const visit = React.useMemo(() => new ProjectVisit({
    accountId: activation.accountId,
    projectId: activation.projectId,
    allowed: () => owner.current.epoch === accountEpoch
      && (!accountSource || (accountSource.getAccountId() === activation.accountId
        && accountSource.getGeneration?.() === accountGeneration)),
    subscribeAccount: (listener) => {
      owner.current.listeners.add(listener);
      const unsubscribe = accountSource?.subscribe(listener);
      return () => { owner.current.listeners.delete(listener); unsubscribe?.(); };
    },
    confirmed: () => {
      void queryClient.invalidateQueries({ queryKey: ['studios', 'recent'] });
      void queryClient.invalidateQueries({ predicate: (query) => isStudioProjectsListKey(query.queryKey) });
    },
  }), [activation, accountEpoch, accountSource, accountGeneration, queryClient]);

  React.useLayoutEffect(() => {
    owner.current.epoch = accountEpoch;
    for (const listener of owner.current.listeners) listener();
  }, [accountEpoch]);
  React.useLayoutEffect(() => {
    visit.activate(notify);
    return () => { visit.deactivate(); };
  }, [visit]);
  React.useEffect(() => {
    if (enabled) visit.start();
  }, [visit, enabled]);
  React.useEffect(() => queryClient.getQueryCache().subscribe((event) => {
    if (event.type !== 'updated' || event.action.type !== 'success' || event.action.manual) return;
    const key = event.query.queryKey;
    if (key.length !== 2 || key[0] !== 'project' || key[1] !== projectId) return;
    if (visit.status === 'pending' || visit.status === 'unconfirmed') void visit.refresh();
  }), [projectId, queryClient, visit]);
  React.useEffect(() => {
    /**
     * A persisted page is a real entry, rather than a provider reconnect.
     * @param event - Browser document activation.
     * @throws {never} Never.
     */
    function restored(event: PageTransitionEvent): void {
      if (event.persisted) setRestoration((previous) => previous + 1);
    }
    window.addEventListener('pageshow', restored);
    return () => { window.removeEventListener('pageshow', restored); };
  }, []);
  return visit;
}
