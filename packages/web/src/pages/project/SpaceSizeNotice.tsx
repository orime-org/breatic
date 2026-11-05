// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import * as React from 'react';
import { Info, TriangleAlert } from 'lucide-react';

import { formatBytes, type SpaceType } from '@breatic/shared';

import { useDocSize } from '@web/data/yjs/doc-size';
import { useTranslation } from '@web/i18n/use-translation';
import { cn } from '@web/lib/utils';

interface SpaceSizeNoticeProps {
  /** Canonical name of the Space's content document. */
  docName: string;
  spaceType: SpaceType;
}

/**
 * Says how full this Space's document is once it nears its size cap
 * (inner#1790): an info line from the warning phase, a warning line once it
 * is full. A rebuild after a refused update keeps the line of the phase in
 * effect before it, until the new connection has synced. Viewers never see it;
 * `SpaceOutlet` does not render it for them.
 * @param root0 - Props.
 * @param root0.docName - Canonical name of the Space's content document.
 * @param root0.spaceType - The Space type, which words the full line.
 * @returns The notice, or null below the warning phase or while the size is unknown.
 * @throws {never} Never.
 */
export function SpaceSizeNotice({ docName, spaceType }: SpaceSizeNoticeProps): React.JSX.Element | null {
  const t = useTranslation();
  const { shownPhase: phase, bytes, limit } = useDocSize(docName);
  if ((phase !== 'warning' && phase !== 'full') || bytes === null || limit === null) return null;
  const full = phase === 'full';
  const sizes = { used: formatBytes(bytes), limit: formatBytes(limit) };
  // Timeline cannot delete yet (inner#1876) and 3D refuses every edit (inner#1875), so neither says "delete".
  const text = !full ? t('spaces.size.warning', sizes)
    : spaceType === 'timeline' ? t('spaces.size.timelineFull')
      : spaceType === '3d' ? t('spaces.size.threeDFull')
        : t('spaces.size.fullNotice', sizes);
  const Icon = full ? TriangleAlert : Info;
  return (
    <div
      role='status'
      data-testid='space-size-notice'
      data-phase={phase}
      className={cn(
        'flex max-w-full items-center gap-2 rounded-overlay border px-3.5 py-1.5 text-sm shadow-md backdrop-blur-sm',
        full
          ? 'border-status-warning-border bg-status-warning-bg text-status-warning-foreground'
          : 'border-status-info-border bg-status-info-bg text-status-info-foreground',
      )}
    >
      <Icon className='h-4 w-4 shrink-0' aria-hidden />
      <span className='truncate font-medium'>{text}</span>
    </div>
  );
}
