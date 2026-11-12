// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import * as React from 'react';
import { Info, TriangleAlert } from 'lucide-react';

import { formatBytes } from '@breatic/shared';

import { useDocSize } from '@web/data/yjs/doc-size';
import { useTranslation } from '@web/i18n/use-translation';
import { SpaceNoticePill } from '@web/pages/project/SpaceNoticePill';

interface SpaceSizeNoticeProps {
  /** Canonical name of the Space's content document. */
  docName: string;
}

/**
 * Says how full this Space's document is once it nears its size cap
 * (inner#1790, design 5.5): an info line from the warning phase, a warning
 * line once it is full, and past the hard ceiling the line that only whole
 * nodes or passages can go (marked `data-over-ceiling`). Every Space type
 * says the same. A rebuild after a refused update keeps the line of the
 * phase in effect before it, until the new connection has synced. Viewers
 * never see it; `SpaceOutlet` does not render it for them.
 * @param root0 - Props.
 * @param root0.docName - Canonical name of the Space's content document.
 * @returns The notice, or null below the warning phase or while the size is unknown.
 * @throws {never} Never.
 */
export function SpaceSizeNotice({ docName }: SpaceSizeNoticeProps): React.JSX.Element | null {
  const t = useTranslation();
  const { shownPhase: phase, overCeiling, bytes, limit } = useDocSize(docName);
  if ((phase !== 'warning' && phase !== 'full') || bytes === null || limit === null) return null;
  const full = phase === 'full';
  const over = full && overCeiling;
  const sizes = { used: formatBytes(bytes), limit: formatBytes(limit) };
  const text = t(over ? 'spaces.sizeCap.noticeOver' : full ? 'spaces.sizeCap.noticeFull' : 'spaces.sizeCap.noticeWarning', sizes);
  return (
    <SpaceNoticePill
      role='status'
      data-testid='space-size-notice'
      data-phase={phase}
      data-over-ceiling={over ? '' : undefined}
      tone={full ? 'warning' : 'info'}
      icon={full ? TriangleAlert : Info}
    >
      {text}
    </SpaceNoticePill>
  );
}
