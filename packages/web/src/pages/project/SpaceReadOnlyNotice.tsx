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
}

/**
 * The notice itself, for a Space that has a document.
 *
 * Split out so the hook is never called conditionally: a Space type with no
 * document of its own (timeline today) has no connection to report on, and the
 * outer component returns before this one mounts. Same shape as
 * `SpaceDocSync` / `SpaceDocAttach` next door, for the same reason.
 * @param root0 - Which document to report on.
 * @param root0.name - Canonical document name.
 * @returns The notice, or null while this connection may write.
 */
function DocReadOnlyNotice({ name }: { name: string }): React.JSX.Element | null {
  const t = useTranslation();
  const doc = React.useMemo(() => getDoc(name), [name]);
  const { degraded } = useSocket({ name, doc });
  if (!degraded) return null;
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
 * Says so when the server granted THIS Space's connection read-only access.
 *
 * ## Why it lives inside the Space rather than in the page chrome
 *
 * Read-only is a property of ONE document. The ceiling counts the writable
 * connections to a single Space, so the canvas can be full while the document
 * Space beside it has room — one browser tab holds a separate connection per
 * open Space. A notice in the page chrome would claim something about the
 * whole project that is not true of it (user 2026-08-14).
 *
 * ## Why it is not a toast
 *
 * It used to be one, and a toast is the wrong shape: it disappears after four
 * seconds, while this is a STATE that holds until somebody leaves or the page
 * reconnects. Whoever missed those four seconds only finds out by watching
 * their edits fail to stick.
 *
 * ## Why a refusal gets nothing from here
 *
 * `useSocket` separates the two. A DEGRADE (this document is at its tier's
 * ceiling, or the ceiling could not be resolved) clears itself when a seat
 * frees up, so "wait, or reconnect" is advice this person can act on. A
 * REFUSAL means the Space was deleted, the membership was revoked or the
 * session expired; that needs a different message, and each Space still says
 * that one its own way.
 * @param root0 - Which Space's connection to report on.
 * @param root0.projectId - Project the Space belongs to.
 * @param root0.spaceId - The Space.
 * @param root0.type - Space type, which decides the document name.
 * @returns The notice, or null for a Space type with no document.
 */
export function SpaceReadOnlyNotice({
  projectId,
  spaceId,
  type,
}: SpaceReadOnlyNoticeProps): React.JSX.Element | null {
  const buildName = DOC_NAME_BUILDERS[type];
  if (!buildName) return null;
  return <DocReadOnlyNotice name={buildName(projectId, spaceId)} />;
}
