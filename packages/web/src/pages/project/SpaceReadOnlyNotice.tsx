// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import * as React from 'react';
import { TriangleAlert } from 'lucide-react';

import { Button } from '@web/components/ui/button';
import { getDoc } from '@web/data/yjs/manager';
import { useSocket } from '@web/data/yjs/use-socket';
import { useTranslation } from '@web/i18n/use-translation';
import { DOC_NAME_BUILDERS } from '@web/pages/project/SpaceDocSync';
import type { SpaceType } from '@web/spaces';

interface SpaceReadOnlyNoticeProps {
  projectId: string;
  spaceId: string;
  type: SpaceType;
  /**
   * True when this person's ROLE is view-only. Load-bearing, not decoration —
   * see the note on causes in {@link SpaceReadOnlyNotice}.
   */
  readOnly?: boolean;
}

/**
 * The notice itself, for a Space that has a document.
 *
 * Split out so the hook is never called conditionally: a Space type with no
 * document of its own (timeline today) has no connection to report on, and the
 * outer component returns before this one mounts. Same shape as
 * `SpaceDocSync` / `SpaceDocAttach` next door, for the same reason.
 * @param root0 - Which document to report on, and who is looking at it.
 * @param root0.name - Canonical document name.
 * @param root0.readOnly - True when this person's role is view-only.
 * @returns The notice, or null when this connection's read-only is not a degrade.
 */
function DocReadOnlyNotice({
  name,
  readOnly,
}: {
  name: string;
  readOnly: boolean;
}): React.JSX.Element | null {
  const t = useTranslation();
  const doc = React.useMemo(() => getDoc(name), [name]);
  const { writeAccess, status } = useSocket({ name, doc });

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
  // plus its unavailable card), but `CanvasSpace` reads only `provider` off
  // `useSocket` and has no refusal branch at all, so a refused canvas document
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
 * {@link DocReadOnlyNotice}, where all three exclusions are worked out).
 *
 * ## Why it lives inside the Space rather than in the page chrome
 *
 * Read-only is a property of ONE document. The ceiling counts the writable
 * connections to a single Space, so the canvas can be full while the document
 * Space beside it has room. Note what "connection" means on each side: the
 * browser opens ONE WebSocket per tab and attaches each Space's document to it
 * (`data/yjs/collab-socket.tsx`), while the server counts seats per document,
 * keyed by socket — so one tab with three Spaces open holds one socket and
 * three seats, one in each document's ledger. A notice in the page chrome
 * would claim something about the whole project that is not true of it
 * (user 2026-08-14).
 *
 * ## Why it is not a toast
 *
 * It used to be one, and a toast is the wrong shape: it disappears after four
 * seconds, while this holds for as long as the connection does. Whoever missed
 * those four seconds only finds out by watching their edits fail to stick.
 * @param root0 - Which Space's connection to report on, and who is looking.
 * @param root0.projectId - Project the Space belongs to.
 * @param root0.spaceId - The Space.
 * @param root0.type - Space type, which decides the document name.
 * @param root0.readOnly - True when this person's role is view-only.
 * @returns The notice, or null for a Space type with no document.
 */
export function SpaceReadOnlyNotice({
  projectId,
  spaceId,
  type,
  readOnly = false,
}: SpaceReadOnlyNoticeProps): React.JSX.Element | null {
  const buildName = DOC_NAME_BUILDERS[type];
  if (!buildName) return null;
  return (
    <DocReadOnlyNotice
      name={buildName(projectId, spaceId)}
      readOnly={readOnly}
    />
  );
}
