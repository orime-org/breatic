// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import * as React from 'react';

import { docName, getDoc } from '@web/data/yjs/manager';
import { evictDocumentEditor } from '@web/spaces/document/document-editor-cache';
import { useDocumentSchemaIntercept } from '@web/spaces/document/use-document-schema-intercept';

interface DocumentInterceptGuardProps {
  /** Project the Space belongs to. */
  projectId: string;
  /** The document Space to watch. */
  spaceId: string;
}

/**
 * Destroy a document Space's editor the moment this build must stop editing it.
 * Renders nothing.
 *
 * ## Why this is not inside `DocumentSpace`
 *
 * `DocumentSpace` is rendered for the ACTIVE Space only, while an editor is
 * cached per document and deliberately outlives a tab switch — it keeps the
 * undo stack, the selection and any in-flight composition, and it keeps
 * receiving remote updates the whole time. Those two scopes do not match: once
 * the user looks at something else, the editor for the Space they left is still
 * bound to the shared document with nothing left to shut it down.
 *
 * That gap matters because of why the verdict destroys rather than disables:
 * an editor that merely exists rewrites the shared document when it cannot
 * represent what arrives. A background tab does that just as readily as the
 * visible one — the rewriting is driven by remote updates, not by typing.
 *
 * So this is mounted once per OPEN tab (from `SpaceDocSync`), which is the
 * scope the verdict needs. `DocumentSpace` keeps deciding whether to BUILD an
 * editor; destroying one that exists lives here, and only here.
 * @param root0 - Which document to watch.
 * @param root0.projectId - Project the Space belongs to.
 * @param root0.spaceId - The document Space.
 * @returns Nothing.
 */
export function DocumentInterceptGuard({
  projectId,
  spaceId,
}: DocumentInterceptGuardProps): null {
  const name = docName.documentSpace(projectId, spaceId);
  const metaDoc = React.useMemo(
    () => getDoc(docName.projectMeta(projectId)),
    [projectId],
  );

  const { intercepted } = useDocumentSchemaIntercept({ metaDoc });

  React.useEffect(() => {
    if (intercepted) evictDocumentEditor(name);
  }, [intercepted, name]);

  return null;
}
