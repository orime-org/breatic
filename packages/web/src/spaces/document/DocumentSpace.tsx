// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { AlertTriangle, RefreshCw } from 'lucide-react';
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
  // `hasEverSynced` rather than `synced`: the latter answers "is the socket in
  // sync right now" and drops to false on every routine close — a wifi switch,
  // a laptop waking, a collab redeploy. What matters here is whether the
  // content has EVER arrived, because once it has the local document holds it
  // and edits made offline merge cleanly on reconnect. Reading the live flag
  // would tear the editor out of the DOM on every blip, taking the caret, the
  // in-flight IME composition and the reader's place on the page with it.
  //
  // The latch is kept with the document in the provider registry, not here:
  // this component is remounted on every Space-tab switch, and a latch that
  // resets there would show a loading placeholder in front of content the
  // local Y.Doc already holds.
  const { provider, hasEverSynced, status, writeAccess } = useSocket({
    name,
    doc,
  });
  const caretUser = useCaretUser();

  // The server refused this connection permission to write. Two reasons produce
  // it: the user is a viewer, or they are over the document's connection cap.
  // Only the second is worth saying — a viewer's read-only is their role and
  // the UI shows it everywhere else, whereas this one contradicts what the UI
  // believes and is otherwise completely silent: the server drops each update
  // without an error or a disconnect, so a member would write a whole document
  // and find none of it there on reload.
  const writesRefused = writeAccess === 'denied';
  const degradedToReadOnly = writesRefused && !readOnly;

  // A per-document auth rejection: this Space's own document was refused while
  // the project's stays healthy, so `ConnectionBanner` — which reads the
  // project's document — shows nothing. Reachable when a collaborator deletes
  // the Space in the window before this tab reconciles. Nothing will retry it,
  // so the honest thing to render is a failure, not a spinner.
  const unavailable = status === 'authFailed' && !hasEverSynced;

  // The editor belongs to the document, not to this component: switching Space
  // tabs remounts this body, and what the Y.Doc does not hold — undo stack,
  // selection, composition state — would go with it.
  const handle = useDocumentEditor({
    doc,
    name,
    caretProvider: provider,
    caretUser,
    // The server's answer wins over the role we think we have. Letting a
    // refused client keep typing is the worst of both: it looks like it is
    // working, and none of it survives.
    editable: !readOnly && !writesRefused,
    hasEverSynced,
  });
  // Nothing is offered until the document's real content is in. Editing before
  // that is not a lesser version of editing this document — it is editing a
  // different one: what gets typed ends up BESIDE the server's content when it
  // arrives rather than in it, and undoing back to empty in that window
  // destroys the redo stack, because the paragraph that keeps the two layers
  // agreeing is only seeded once a sync has happened. Both measured.
  //
  // The cost is that an unreachable collab service leaves the document
  // permanently unavailable rather than editable-but-doomed. That is the
  // honest reading of the situation — nothing typed then would have been
  // saved — and `ConnectionBanner` at the project level says why (user
  // 2026-07-29 weighed this against the alternative and chose it).
  const editor = hasEverSynced ? (handle?.editor ?? null) : null;
  const history = useDocumentHistory(handle?.undoManager ?? null);

  return (
    <div
      data-testid='document-space'
      data-project-id={projectId}
      data-space-id={spaceId}
      className='flex h-full w-full flex-col bg-background'
    >
      {degradedToReadOnly ? (
        <div
          role='status'
          aria-live='polite'
          data-testid='document-space-readonly-notice'
          className='flex shrink-0 items-center gap-2 border-b border-status-warning-border bg-status-warning-bg px-4 py-2 text-sm text-status-warning-foreground'
        >
          <AlertTriangle className='h-4 w-4 shrink-0' aria-hidden />
          <span>{t('spaces.document.readOnlyNotice')}</span>
        </div>
      ) : null}
      {unavailable ? (
        <div
          role='alert'
          data-testid='document-space-unavailable'
          className='flex h-full w-full flex-col items-center justify-center gap-3 px-6 text-center'
        >
          <AlertTriangle
            className='h-6 w-6 text-status-error-foreground'
            aria-hidden
          />
          <p className='max-w-md text-sm text-muted-foreground'>
            {t('spaces.document.unavailable.text')}
          </p>
          <button
            type='button'
            data-testid='document-space-unavailable-retry'
            onClick={() => window.location.reload()}
            className='inline-flex h-8 items-center gap-1.5 rounded-md border border-border px-3 text-sm font-medium transition-colors duration-150 hover:bg-muted focus-visible:ring-1 focus-visible:ring-active-border focus-visible:outline-none'
          >
            <RefreshCw className='h-3.5 w-3.5' aria-hidden />
            {t('spaces.document.unavailable.action')}
          </button>
        </div>
      ) : editor ? (
        <DocumentEditor
          editor={editor}
          history={history}
          readOnly={readOnly || writesRefused}
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
