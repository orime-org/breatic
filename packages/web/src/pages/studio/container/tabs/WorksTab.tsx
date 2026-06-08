// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import type * as React from 'react';
import { Play } from 'lucide-react';

import { useTranslation } from '@web/i18n/use-translation';
import { EmptyState } from '@web/pages/studio/shared/EmptyState';

/**
 * The Works tab (spec §6.2) — a placeholder empty shell. "Works" are the
 * finished products a project publishes (a video, a mini-game, …); they have
 * NO data model today. The real entity (data model / publish flow / visibility
 * / lifecycle) is deferred to a dedicated DD + Works slice (IA #267 §9/§13);
 * this tab only holds the 3rd navigation slot with a fixed empty state (neutral
 * mock §works-empty, no CTA — the publish feature isn't live) — zero backend.
 * @returns the Works tab empty state.
 */
export function WorksTab(): React.JSX.Element {
  const t = useTranslation();
  return (
    <EmptyState
      icon={Play}
      title={t('studio.container.works.emptyTitle')}
      hint={t('studio.container.works.emptyHint')}
    />
  );
}
