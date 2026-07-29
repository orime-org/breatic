// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import * as React from 'react';

import { docName, getDoc } from '@web/data/yjs/manager';
import { useCaretUser } from '@web/data/yjs/use-caret-user';
import { useSocket } from '@web/data/yjs/use-socket';
import { useTranslation } from '@web/i18n/use-translation';
import type { SpaceBodyProps } from '@web/spaces';
import { DocumentEditor } from '@web/spaces/document/DocumentEditor';
import { useDocumentEditor } from '@web/spaces/document/use-document-editor';
import { useDocumentHistory } from '@web/spaces/document/use-document-history';

/**
 * Document space body — a collaborative rich-text document.
 *
 * This is the container: it resolves the Space's Yjs document, joins the shared
 * collab socket for collaborator carets, and hands the resulting editor to
 * {@link DocumentEditor} for presentation.
 *
 * The socket acquire here is a cheap share, not a second connection —
 * `SpaceDocSync` already holds a reference to the same document for as long as
 * the tab is open, and the provider registry is reference-counted.
 * @param root0 - Space body props supplied by the project space outlet.
 * @param root0.spaceId - ID of the document space.
 * @param root0.projectId - ID of the owning project.
 * @param root0.readOnly - True for a viewer; the body and toolbar go read-only.
 * @returns The document editor, or a loading placeholder while it mounts.
 */
export function DocumentSpace({
  spaceId,
  projectId,
  readOnly = false,
}: SpaceBodyProps): React.JSX.Element {
  const t = useTranslation();
  const name = docName.documentSpace(projectId, spaceId);
  const doc = React.useMemo(() => getDoc(name), [name]);
  const { provider, synced } = useSocket({ name, doc });
  const caretUser = useCaretUser();

  // The editor belongs to the document, not to this component: switching Space
  // tabs remounts this body, and what the Y.Doc does not hold — undo stack,
  // selection, composition state — would go with it.
  const handle = useDocumentEditor({
    doc,
    name,
    caretProvider: provider,
    caretUser,
    editable: !readOnly,
    synced,
  });
  const editor = handle?.editor ?? null;
  const history = useDocumentHistory(handle?.undoManager ?? null);

  return (
    <div
      data-testid='document-space'
      data-project-id={projectId}
      data-space-id={spaceId}
      className='flex h-full w-full flex-col bg-background'
    >
      {editor ? (
        <DocumentEditor
          editor={editor}
          history={history}
          readOnly={readOnly}
        />
      ) : (
        <div
          data-testid='document-space-loading'
          className='flex h-full w-full items-center justify-center text-sm text-muted-foreground'
        >
          {t('spaces.document.loading')}
        </div>
      )}
    </div>
  );
}
