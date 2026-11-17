// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What a failure of the payer's own key is said with on a Project page (inner#1953): whose key it is to the viewer and
 * each upstream's name on screen, off the Project's key plan. Read once for the page, because the sentence is drawn in
 * the task list, the node history, the 3D task list and the Agent's replies, deep under components that pass nothing
 * of the Project down. Outside a provider, or before the plan arrives, there is none and the sentence names no owner.
 */

import * as React from 'react';

import { useKeyPlan } from '@web/features/byok/byok-query';

/** Whose key the viewer is told failed, and what each upstream is called. */
export interface KeyFailureWords {
  payer: 'self' | 'admin';
  upstreamNames: Readonly<Record<string, string>>;
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
  const upstreamNames = plan?.upstreamNames;
  const words = React.useMemo(
    () => (payer === undefined || upstreamNames === undefined ? undefined : { payer, upstreamNames }),
    [payer, upstreamNames],
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
