// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * What a failure of the payer's own key is said with on a Project page (inner#1953): whose key it is to the viewer and
 * each upstream's name on screen, off the Project's key plan. Read once for the page, because the sentence is drawn in
 * the task list, the node history, the 3D task list and the Agent's replies, deep under components that pass nothing
 * of the Project down. Outside a provider, or before the plan arrives, there is none and the sentence names no owner.
 */

import * as React from 'react';

import { useKeyPlan } from '@web/features/byok/byok-query';
import { useCurrentUserStore } from '@web/stores/current-user';

/** Whose key the viewer is told failed, and what each upstream is called. */
export interface KeyFailureWords {
  /** Whose keys pay for the Studio now: the viewer's own, or the Studio Admin's. */
  payer: 'self' | 'admin';
  /** The account that pays for the Studio now; null when it has none. */
  payerUserId: string | null;
  /** The signed-in account. */
  viewerUserId: string | undefined;
  upstreamNames: Readonly<Record<string, string>>;
}

/**
 * Whose key a failure was on, as the viewer is told it: their own, the current Studio Admin's, or neither, once the
 * Studio has changed hands since. A failure that recorded no owner is read as the current payer's.
 * @param words - The page's words; undefined names no owner.
 * @param keyOwner - The account whose key the failure recorded.
 * @returns The ICU `whose` value.
 */
export function whoseKey(words: KeyFailureWords | undefined, keyOwner: string | undefined): 'self' | 'admin' | 'other' {
  if (words === undefined) return 'other';
  if (keyOwner === undefined) return words.payer;
  if (keyOwner === words.viewerUserId) return 'self';
  return keyOwner === words.payerUserId ? 'admin' : 'other';
}

const KeyFailureWordsContext = React.createContext<KeyFailureWords | undefined>(undefined);

/**
 * Reads the Project's key plan and hands its words to every failure sentence below.
 * @param root0 - Provider props.
 * @param root0.projectId - The Project the page shows.
 * @param root0.children - The page.
 * @returns The provider.
 */
export function KeyFailureWordsProvider({
  projectId,
  children,
}: {
  projectId: string;
  children: React.ReactNode;
}): React.JSX.Element {
  const plan = useKeyPlan(projectId).data;
  const payer = plan?.payer;
  const payerUserId = plan?.payerUserId ?? null;
  const upstreamNames = plan?.upstreamNames;
  const viewerUserId = useCurrentUserStore((s) => s.user?.id);
  const words = React.useMemo(
    () => (payer === undefined || upstreamNames === undefined ? undefined : { payer, payerUserId, viewerUserId, upstreamNames }),
    [payer, payerUserId, viewerUserId, upstreamNames],
  );
  return <KeyFailureWordsContext.Provider value={words}>{children}</KeyFailureWordsContext.Provider>;
}

/**
 * The words a key failure on this Project page is said with.
 * @returns Them, or undefined outside a provider or before the key plan arrives.
 */
export function useKeyFailureWords(): KeyFailureWords | undefined {
  return React.useContext(KeyFailureWordsContext);
}
