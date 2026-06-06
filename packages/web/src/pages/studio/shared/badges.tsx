// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import type * as React from 'react';
import { Lock } from 'lucide-react';

import { Badge } from '@web/components/ui/badge';
import { useTranslation } from '@web/i18n/use-translation';
import type {
  CollectionKind,
  CreditLotSource,
} from '@web/pages/studio/container/container-types';
import type {
  ItemRole,
  ItemVisibility,
  StudioType,
} from '@web/pages/studio/shared/studio-types';

// All badges carry TEXT (not color alone) for a11y (spec §3.5). Badges use the
// mode-aware `secondary` / `muted` tokens, never raw `neutral-*` (which is
// mode-blind). The studio chrome is neutral (visual ADR 2026-06-06 — studio no
// longer brand-exempt): the type pill + collection-kind tag read as a neutral
// tint, not brand.
const NEUTRAL_TINT =
  'border-transparent bg-muted text-muted-foreground';

/**
 * Project / collection visibility badge (spec §3.5): studio-visible (neutral)
 * or private (neutral + lock icon). Always neutral — never brand.
 * @param props the item visibility.
 * @param props.visibility the item visibility.
 * @returns the visibility badge.
 */
export function VisibilityBadge({
  visibility,
}: {
  visibility: ItemVisibility;
}): React.JSX.Element {
  const t = useTranslation();
  if (visibility === 'private') {
    return (
      <Badge variant='secondary' className='gap-1'>
        <Lock className='h-3 w-3' aria-hidden='true' />
        {t('studio.container.badge.visibilityPrivate')}
      </Badge>
    );
  }
  return (
    <Badge variant='secondary'>
      {t('studio.container.badge.visibilityStudio')}
    </Badge>
  );
}

/**
 * The viewer's role badge (spec §3.5) — neutral only (brand forbidden for
 * roles, §F10); Owner reads slightly heavier than Editor / Viewer.
 * @param props the viewer's role.
 * @param props.itemRole the role to label.
 * @returns the role badge.
 */
export function RoleBadge({
  itemRole,
}: {
  itemRole: ItemRole;
}): React.JSX.Element {
  const t = useTranslation();
  const key =
    itemRole === 'owner'
      ? 'roleOwner'
      : itemRole === 'editor'
        ? 'roleEditor'
        : 'roleViewer';
  return (
    <Badge
      variant='secondary'
      className={itemRole === 'owner' ? 'text-foreground' : undefined}
    >
      {t(`studio.container.badge.${key}`)}
    </Badge>
  );
}

/**
 * Studio type pill (spec §3.5) — neutral tint (personal / team).
 * @param props the studio type.
 * @param props.type the studio type.
 * @returns the type pill.
 */
export function StudioTypePill({
  type,
}: {
  type: StudioType;
}): React.JSX.Element {
  const t = useTranslation();
  const key = type === 'team' ? 'typeTeam' : 'typePersonal';
  return (
    <Badge className={`rounded-full ${NEUTRAL_TINT}`}>
      {t(`studio.container.badge.${key}`)}
    </Badge>
  );
}

/**
 * Collection media-kind tag (spec §3.4) — neutral tint (image / video / audio).
 * @param props the collection kind.
 * @param props.kind the dialog / collection kind.
 * @returns the kind tag.
 */
export function CollectionKindTag({
  kind,
}: {
  kind: CollectionKind;
}): React.JSX.Element {
  const t = useTranslation();
  const key =
    kind === 'image' ? 'kindImage' : kind === 'video' ? 'kindVideo' : 'kindAudio';
  return (
    <Badge className={NEUTRAL_TINT}>{t(`studio.container.badge.${key}`)}</Badge>
  );
}

/**
 * Credit lot badge (spec §3.5 / §3.6): paid lots read success (green), gift
 * lots read locked (amber), and gift lots within their expiry window read
 * destructive (red) with the remaining days.
 * @param props the lot source and, when expiring soon, the remaining days.
 * @param props.source the credit lot source.
 * @param props.expiringDays the remaining days when the lot is expiring soon.
 * @returns the lot badge.
 */
export function CreditLotBadge({
  source,
  expiringDays,
}: {
  source: CreditLotSource;
  expiringDays?: number;
}): React.JSX.Element {
  const t = useTranslation();
  if (expiringDays !== undefined) {
    return (
      <Badge className='border-transparent bg-status-error-bg text-status-error-foreground'>
        {t('studio.container.badge.lotExpiring', { days: expiringDays })}
      </Badge>
    );
  }
  if (source === 'paid') {
    return (
      <Badge className='border-transparent bg-status-success-bg text-status-success-foreground'>
        {t('studio.container.badge.lotPaid')}
      </Badge>
    );
  }
  return (
    <Badge className='border-transparent bg-status-locked-bg text-status-locked-foreground'>
      {t('studio.container.badge.lotGift')}
    </Badge>
  );
}
