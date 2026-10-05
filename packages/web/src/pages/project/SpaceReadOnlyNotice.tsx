// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';
import { TriangleAlert } from 'lucide-react';

import { Button } from '@web/components/ui/button';
import { useSpaceConnection } from '@web/data/yjs/space-connection';
import { useTranslation } from '@web/i18n/use-translation';

interface SpaceReadOnlyNoticeProps {
  /**
   * True when this person's ROLE is view-only. Load-bearing, not decoration —
   * see the note on causes in {@link SpaceReadOnlyNotice}.
   */
  readOnly?: boolean;
}

/**
 * Says so when THIS Space's connection was granted read-only although this
 * person's role can write.
 *
 * ## What it does and does not announce
 *
 * Only a connection-level degrade — the document is at the ceiling its tier
 * allows, or that ceiling could not be resolved at all. A viewer is told
 * nothing (read-only is their role, not something taken away), the project
 * meta document never reaches here, and a refused document is out of scope
 * (which is not the same as saying somebody else reports it — see the note in
 * the function body, where all three exclusions are worked out).
 *
 * ## Why it lives inside the Space rather than in the page chrome
 *
 * Read-only is a property of ONE document. The ceiling counts the writable
 * connections to a single Space, so the canvas can be full while the document
 * Space beside it has room. Note what "connection" means on each side: the
 * browser opens ONE WebSocket per tab and attaches each Space's document to it
 * (`data/yjs/collab-socket.tsx`), while the server counts seats per document,
 * keyed by socket. So one tab with three Spaces open holds one socket and up
 * to three seats — one in each document's ledger, and only for the documents
 * this connection may actually write, since a read-only attachment takes no
 * seat at all. A notice in the page chrome would claim something about the
 * whole project that is not true of it (user 2026-08-14).
 *
 * ## Why it is not a toast
 *
 * It used to be one, and a toast is the wrong shape: it disappears after four
 * seconds, while this holds for as long as the connection does. Whoever missed
 * those four seconds only finds out by watching their edits fail to stick.
 *
 * ## Which connection
 *
 * The tab's own (`useSpaceConnection`), held by `OpenSpace` from open to close
 * for this Space's document. A Space type with no document has no connection
 * around it, reads write access as unknown, and so shows nothing.
 * @param root0 - Who is looking.
 * @param root0.readOnly - True when this person's role is view-only.
 * @returns The notice, or null when this connection's read-only is not a degrade.
 */
export function SpaceReadOnlyNotice({
  readOnly = false,
}: SpaceReadOnlyNoticeProps): React.JSX.Element | null {
  const t = useTranslation();
  const { writeAccess, status } = useSpaceConnection();

  // The server sends ONE flag for three different causes (collab
  // `hooks/auth.ts`: `readOnly = kind === "meta" || role === "viewer" ||
  // atCapacity`) and the wire carries no reason. So "did the server say no" is
  // not the question — "was this person's editing taken away" is. Two of those
  // three causes are ruled out from what this side already knows:
  //
  //   the role  — a viewer is read-only in every Space, always. Nothing was
  //               taken away, so there is nothing to announce. It comes from
  //               the caller, because a connection does not carry a role.
  //   meta      — no client may ever write it. Ruled out by construction:
  //               `DOC_NAME_BUILDERS` only ever names a Space's own document.
  //
  // A REFUSAL is a fourth state, not one of that flag's causes: the Space was
  // deleted, the membership was revoked, the session expired. It denies writes
  // too and is told apart by `authFailed`, and it is excluded here for a
  // different reason — telling that person to wait for a seat is an
  // instruction they cannot carry out. **Nobody else announces it on a
  // canvas.** `DocumentSpace` does say it (`spaces.document.refusedNotice`,
  // plus its unavailable card), but `CanvasSpace` reads only `provider` and
  // `synced` off its connection and has no refusal branch at all, so a refused
  // canvas document
  // is currently silent everywhere. That gap is not this component's to close —
  // this notice is about seats, and a refusal is not a seat problem — but do
  // not read the exclusion as "some other component has it covered".
  //
  // What is left is the connection being read-only while the role can write:
  // the document is at its tier's ceiling, or that ceiling could not be
  // resolved. The two are deliberately NOT distinguished — from where the user
  // sits they are one event with one answer (user 2026-08-14).
  const degraded = writeAccess === 'denied' && status !== 'authFailed';
  if (readOnly || !degraded) return null;

  return (
    <div
      role='status'
      aria-live='polite'
      data-testid='space-read-only-notice'
      className='absolute top-2.5 left-1/2 z-10 flex max-w-[calc(100%-2rem)] -translate-x-1/2 items-center gap-2 rounded-overlay border border-status-warning-border bg-status-warning-bg px-3.5 py-1.5 text-sm text-status-warning-foreground shadow-md backdrop-blur-sm'
    >
      <TriangleAlert className='h-4 w-4 shrink-0' aria-hidden />
      <span className='truncate font-medium'>{t('spaces.readOnlyNotice')}</span>
      <Button
        variant='outline'
        size='sm'
        data-testid='space-read-only-notice-reconnect'
        className='h-6 shrink-0 border-status-warning-border px-2 text-xs text-status-warning-foreground hover:bg-status-warning-bg hover:text-status-warning-foreground'
        onClick={() => window.location.reload()}
      >
        {t('spaces.readOnlyReconnect')}
      </Button>
    </div>
  );
}
