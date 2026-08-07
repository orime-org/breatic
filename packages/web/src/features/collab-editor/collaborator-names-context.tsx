// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Who the collaborators in this project are called, available to any editor
 * without anything in between having to carry it.
 *
 * The roster is a PROJECT-level fact — one fetch, one answer, the same for
 * every space and every editor on the page — but the editors that need it sit
 * six or seven layers down. Handing it over as a prop meant each of those
 * layers writing "I received it, I pass it on", and every one of those lines
 * was optional: drop one and TypeScript, ESLint and the whole test suite stay
 * silent while every remote caret loses its name. Three rounds of adversarial
 * review found four such breaks, so the fix was to remove the act of
 * forwarding rather than to guard each place it could be forgotten (#1882).
 *
 * A subtree with no provider resolves nobody, which is the same answer as a
 * roster that has not loaded yet: the caret renders as a bare coloured line.
 * That makes an isolated component test — or any future editor mounted
 * outside a project — degrade quietly and correctly rather than throw.
 */

import * as React from 'react';

import type { CollaboratorNames } from '@web/features/collab-editor/use-collaborator-names';

const CollaboratorNamesContext = React.createContext<CollaboratorNames | null>(
  null,
);

interface CollaboratorNamesProviderProps {
  /** The roster bundle, or null while it has not resolved. */
  value: CollaboratorNames | null;
  /** Optional so callers may pass children as createElement's third argument. */
  children?: React.ReactNode;
}

/**
 * Publish the project's roster to every editor below.
 * @param root0 - The component props.
 * @param root0.value - The roster bundle, or null before it resolves.
 * @param root0.children - The subtree that may resolve names.
 * @returns The subtree wrapped in the roster context.
 */
export function CollaboratorNamesProvider({
  value,
  children,
}: CollaboratorNamesProviderProps): React.JSX.Element {
  return (
    <CollaboratorNamesContext.Provider value={value}>
      {children}
    </CollaboratorNamesContext.Provider>
  );
}

/**
 * Read the surrounding project's roster.
 * @returns The roster bundle, or null outside a provider / before it loads.
 */
export function useCollaboratorNames(): CollaboratorNames | null {
  return React.useContext(CollaboratorNamesContext);
}
