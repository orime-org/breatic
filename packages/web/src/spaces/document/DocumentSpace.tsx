// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { AlertTriangle, RefreshCw } from 'lucide-react';
import * as React from 'react';

import { Button } from '@web/components/ui/button';
import { toast } from '@web/lib/toast';
import { docName, getDoc } from '@web/data/yjs/manager';
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

  // This Space's own document was refused, or the server granted it read-only.
  // Both are told to the user, and since 2026-08-14 they part company on what
  // else happens: a REFUSAL leaves the editor alive (decision 2026-08-02 — an
  // editor that still accepts typing while a message says the server refused
  // it tells the user exactly where the fault is; one that goes dead tells
  // them only that something broke, and takes away content they may want to
  // copy out), while a DEGRADE stops it, because a degrade means this socket
  // may not change the server's data and the canvas enforces exactly that.
  //
  // The message cannot name a cause, because the wire does not carry one — the
  // server sends "readonly" / "read-write" and sets it for a viewer, for a
  // member over the connection cap, and for a refused document alike. So it
  // states the fact and what follows from it.
  //
  // A viewer is not told: their read-only is their role, shown everywhere else.
  const refused = status === 'authFailed';
  const writesRefused = writeAccess === 'denied' && !readOnly;
  // A DEGRADE, told apart from a refusal: `writeAccess` is 'denied' for both,
  // so the only thing that separates "the document is full" from "the server
  // refused this document outright" is that a refusal sets `authFailed`.
  // The two get different answers below — the notice, and whether the editor
  // still takes typing.
  const degraded = writesRefused && !refused;

  // The one case where nothing can be shown: refused before any content ever
  // arrived, so there is no document to display. That is not "disabled", it is
  // empty — and what fills the space is a statement of the very problem.
  const unavailable = refused && !hasEverSynced;

  // Told once per transition, not re-announced on every render.
  React.useEffect(() => {
    if (refused && hasEverSynced) toast.error(t('spaces.document.refusedNotice'));
  }, [refused, hasEverSynced, t]);
  React.useEffect(() => {
    if (degraded) toast.warning(t('spaces.readOnlyNotice'));
  }, [degraded, t]);

  // The editor belongs to the document, not to this component: switching Space
  // tabs remounts this body, and what the Y.Doc does not hold — undo stack,
  // selection, composition state — would go with it.
  const handle = useDocumentEditor({
    doc,
    name,
    caretProvider: provider,
    // Two of the three states stop typing, and the third deliberately does
    // not. The ROLE (a viewer) stops it, as it always has. A connection the
    // server DEGRADED to read-only stops it too since 2026-08-14 (#88): a
    // degrade means this socket may not change the server's data, the canvas
    // enforces exactly that, and one server signal answered two opposite ways
    // in two Spaces is a difference that drifts.
    //
    // A REFUSED document still takes typing — decision 2026-08-02, unchanged.
    // A document that goes dead tells the person only that something broke and
    // takes away content they may want to copy out; one that still accepts
    // typing while saying the server refused it tells them where the fault is.
    editable: !readOnly && !degraded,
  });
  // Nothing is offered until the document's real content is in. Editing before
  // that is not a lesser version of editing this document — it is editing a
  // different one: what gets typed ends up BESIDE the server's content when it
  // arrives rather than in it. Measured.
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
          <Button
            variant={null}
            size={null}
            type='button'
            data-testid='document-space-unavailable-retry'
            onClick={() => window.location.reload()}
            className='inline-flex h-8 items-center gap-1.5 rounded-md border border-border px-3 text-sm font-medium transition-colors duration-150 hover:bg-muted focus-visible:ring-1 focus-visible:ring-active-border focus-visible:outline-none'
          >
            <RefreshCw className='h-3.5 w-3.5' aria-hidden />
            {t('spaces.document.unavailable.action')}
          </Button>
        </div>
      ) : editor ? (
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
