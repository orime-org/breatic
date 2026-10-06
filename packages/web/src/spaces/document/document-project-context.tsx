// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The project a document sits in, for the entries that hand its words to the
 * Agent (inner#936).
 *
 * A context rather than a prop because the block handle is rendered by
 * BlockNote's `SideMenuController`, which passes nothing of ours down. Outside
 * a provider there is no project to hand anything to, and the entries that
 * need one are not drawn.
 */

import * as React from 'react';

const DocumentProjectContext = React.createContext<string | null>(null);

/**
 * Provides the project id to the document's editor and its menus.
 * @param root0 - Provider props.
 * @param root0.projectId - The project the document is in.
 * @param root0.children - The editor.
 * @returns The provider.
 */
export function DocumentProjectProvider({
  projectId,
  children,
}: {
  projectId: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <DocumentProjectContext.Provider value={projectId}>{children}</DocumentProjectContext.Provider>
  );
}

/**
 * The project the document is in.
 * @returns Its id, or null outside a provider.
 */
export function useDocumentProjectId(): string | null {
  return React.useContext(DocumentProjectContext);
}
