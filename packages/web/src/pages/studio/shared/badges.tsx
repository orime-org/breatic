// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import type * as React from 'react';
import { Lock } from 'lucide-react';

import { Badge } from '@web/components/ui/badge';
import { useTranslation } from '@web/i18n/use-translation';
import type { CreditLotSource } from '@web/pages/studio/container/container-types';
import type {
  ItemRole,
  ItemVisibility,
  StudioType,
} from '@web/pages/studio/shared/studio-types';

// All badges carry TEXT (not color alone) for a11y (spec §3.5). Body badges use
// the mode-aware `secondary` / `muted` tokens, never raw `neutral-*` (which is
// mode-blind). The studio chrome is neutral (visual ADR 2026-06-06 — studio no
// longer brand-exempt): the type pill reads as a neutral tint, not brand.
const NEUTRAL_TINT =
  'border-transparent bg-muted text-muted-foreground';

// The card visibility overlay sits on the thumbnail image, so it is
// deliberately mode-independent (dark scrim + white text) — like the locked mock
// `.vbadge`. Black/white here are NOT theme tokens (an image overlay must read
// the same in light + dark mode), so this is not a token violation.
const VISIBILITY_OVERLAY =
  'inline-flex items-center gap-1 rounded-[2px] bg-black/45 px-1.5 text-[11px] font-semibold leading-5 text-white';

/**
 * Project / collection visibility badge (spec §3.5) — a dark overlay pill that
 * sits on the card thumbnail's top-left (locked mock `.vbadge`): studio-visible,
 * or private with a lock icon. The card positions it absolutely.
 * @param props the item visibility.
 * @param props.visibility the item visibility.
 * @returns the visibility overlay badge.
 */
export function VisibilityBadge({
  visibility,
}: {
  visibility: ItemVisibility;
}): React.JSX.Element {
  const t = useTranslation();
  if (visibility === 'private') {
    return (
      <span className={VISIBILITY_OVERLAY}>
        <Lock className='h-3 w-3' aria-hidden='true' />
        {t('studio.container.badge.visibilityPrivate')}
      </span>
    );
  }
  return (
    <span className={VISIBILITY_OVERLAY}>
      {t('studio.container.badge.visibilityStudio')}
    </span>
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
      className={
        itemRole === 'owner' ? 'rounded-[2px] text-foreground' : 'rounded-[2px]'
      }
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
