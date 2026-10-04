// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { AlertTriangle, RefreshCw } from 'lucide-react';
import * as React from 'react';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@web/components/ui/alert-dialog';
import { Button } from '@web/components/ui/button';
import { toast } from '@web/lib/toast';
import { docName, getDoc } from '@web/data/yjs/manager';
import { useSpaceConnection } from '@web/data/yjs/space-connection';
import { useTranslation } from '@web/i18n/use-translation';
import { useCurrentUserStore } from '@web/stores/current-user';
import type { SpaceBodyProps } from '@web/spaces';
import { DocumentSchemaOutdated } from '@web/spaces/document/DocumentSchemaOutdated';
import { useDocumentSchemaIntercept } from '@web/spaces/document/use-document-schema-intercept';
import { clearDocument } from '@web/spaces/document/document-select-all-guard';
import { DocumentEditor } from '@web/spaces/document/DocumentEditor';
import { useDocumentEditor } from '@web/spaces/document/use-document-editor';

/**
 * Document space body — a collaborative rich-text document.
 *
 * This is the container: it resolves the Space's Yjs document, reads the
 * connection its tab holds (`OpenSpace`) for collaborator carets, and hands the
 * resulting editor to {@link DocumentEditor} for presentation.
 * @param root0 - Space body props supplied by the project space outlet.
 * @param root0.spaceId - ID of the document space.
 * @param root0.projectId - ID of the owning project.
 * @param root0.readOnly - True for a viewer; the body goes read-only.
 * @param root0.myRole - This reader's role on the project.
 * @returns The document editor, or a loading placeholder while it mounts.
 */
export function DocumentSpace({
  spaceId,
  projectId,
  readOnly = false,
  myRole = 'viewer',
}: SpaceBodyProps): React.JSX.Element {
  const t = useTranslation();
  const viewerId = useCurrentUserStore((state) => state.user?.id);

  // The comment store asks who is reading before every write it authorises,
  // and it asks the editor — which is built once per document and kept across
  // Space-tab switches. So what it gets is a reading off the latest render
  // rather than the values this one happened to have: a reader demoted while
  // the document is open stops being able to write (A17), and one promoted
  // starts, neither of them needing the Space reopened.
  const who = React.useRef({ role: myRole, viewerId });
  who.current = { role: myRole, viewerId };
  const readWho = React.useCallback(() => who.current, []);
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
  // Read from the tab rather than subscribed here: this body is hidden, not
  // unmounted, on a Space-tab switch, and hiding cleans up its effects. A
  // subscription of its own would start over as "never synced" on the way
  // back and put a loading placeholder in front of content the local Y.Doc
  // already holds.
  const { provider, hasEverSynced, status } = useSpaceConnection();

  // This Space's own document was REFUSED — deleted, membership revoked, or the
  // session expired. It is told to the user and does NOT disable the editor:
  // showing the problem where it is and leaving everything else working is the
  // rule (decision 2026-08-02). An editor that still accepts typing while a
  // message says the server refused it tells the user exactly where the fault
  // is; one that goes dead tells them only that something broke, and takes away
  // content they may want to copy out.
  //
  // A DEGRADE is the other thing `writeAccess: 'denied'` can mean, and it is no
  // longer handled here (#88): `SpaceReadOnlyNotice` announces it, every Space
  // type gets that from the outlet, and it stays on screen for as long as the
  // state holds instead of four seconds.
  const refused = status === 'authFailed';

  // The one case where nothing can be shown: refused before any content ever
  // arrived, so there is no document to display. That is not "disabled", it is
  // empty — and what fills the space is a statement of the very problem.
  const unavailable = refused && !hasEverSynced;

  // Told once per transition, not re-announced on every render.
  React.useEffect(() => {
    if (refused && hasEverSynced) toast.error(t('spaces.document.refusedNotice'));
  }, [refused, hasEverSynced, t]);

  // The editor belongs to the document, not to this component: switching Space
  // tabs remounts this body, and what the Y.Doc does not hold — undo stack,
  // selection, composition state — would go with it.
  // This build's vocabulary against the one the server publishes, and against
  // what this document actually holds. Read from the project's meta document —
  // the same instance the project page is already subscribed to, since
  // `getDoc` is keyed by name; nothing is opened here.
  const metaDoc = React.useMemo(
    () => getDoc(docName.projectMeta(projectId)),
    [projectId],
  );
  const { intercepted, publishedAt } = useDocumentSchemaIntercept({
    metaDoc,
  });

  const handle = useDocumentEditor({
    doc,
    name,
    caretProvider: provider,
    readWho,
    // Only the ROLE decides this. A refused or read-only connection is reported
    // to the user, not enforced against them — see above.
    editable: !readOnly,
    // Whereas THIS is enforced: an older build's edits do not merely fail to
    // save, they destroy what a newer one wrote. No editor is built while it
    // holds, and one already built is destroyed.
    //
    // `hasEverSynced` is part of the same gate, and has to be: building an
    // editor first and letting the content arrive into it means the Yjs
    // binding converts the shared document to a ProseMirror one — here
    // y-prosemirror, reached through `@blocknote/core/yjs` — and that
    // conversion
    // DELETES from the shared document whatever it cannot represent. The
    // deletion happens inside Yjs's type observers, which run before
    // `doc.on('update')` — so the intercept, which counts unresolvable names in
    // the document, looks after the names are already gone and answers "nothing
    // here". Measured. Ordering it the other way round — content, then verdict,
    // then editor — is what makes the verdict able to see anything at all.
    enabled: hasEverSynced && !intercepted,
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
  const shown = hasEverSynced ? handle : null;

  // The guarded whole-document delete: the extension asks instead of deleting
  // (see document-select-all-guard.ts), and this mount answers with the dialog.
  const [clearAsked, setClearAsked] = React.useState(false);
  React.useEffect(() => {
    if (!handle) return undefined;
    return handle.onClearDocumentRequest(() => setClearAsked(true));
  }, [handle]);
  const onClearConfirm = React.useCallback(() => {
    if (handle) clearDocument(handle.editor);
  }, [handle]);
  // Focus is handed back HERE, on every way out of the dialog — confirm,
  // cancel, Escape. There is no trigger element to return to (a keystroke
  // opened it), so Radix's default would drop focus on <body>, stranding the
  // keyboard (measured; same shape as the Space drawer's confirm).
  const onClearCloseAutoFocus = React.useCallback(
    (event: Event) => {
      event.preventDefault();
      // The dialog's unmount can outlive the editor: closing a tab while the
      // dialog is up unmounts the editor first, and every route to the view of
      // an unmounted editor raises rather than answering nothing.
      try {
        handle?.editor.focus();
      } catch {
        // The editor is gone; there is nowhere to put the focus back.
      }
    },
    [handle],
  );

  return (
    <div
      data-testid='document-space'
      data-project-id={projectId}
      data-space-id={spaceId}
      className='flex h-full w-full flex-col bg-background'
    >
      {intercepted ? (
        <DocumentSchemaOutdated publishedAt={publishedAt} />
      ) : unavailable ? (
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
      ) : shown ? (
        <DocumentEditor handle={shown} readOnly={readOnly} myRole={myRole} />
      ) : (
        <div
          data-testid='document-space-loading'
          className='flex h-full w-full items-center justify-center text-sm text-muted-foreground'
        >
          {t('spaces.document.loading')}
        </div>
      )}
      <AlertDialog open={clearAsked} onOpenChange={setClearAsked}>
        <AlertDialogContent
          data-testid='document-clear-confirm'
          aria-describedby={undefined}
          onCloseAutoFocus={onClearCloseAutoFocus}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('spaces.document.clearConfirm.title')}
            </AlertDialogTitle>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              {t('spaces.document.clearConfirm.cancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              variant='destructive'
              onClick={onClearConfirm}
              data-testid='document-clear-confirm-action'
            >
              {t('spaces.document.clearConfirm.confirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
