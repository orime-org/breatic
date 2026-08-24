// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type * as React from 'react';
import { Lock } from 'lucide-react';

import { Badge } from '@web/components/ui/badge';
import { useTranslation } from '@web/i18n/use-translation';
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
  'inline-flex items-center gap-1 rounded-chrome bg-black/45 px-1.5 text-2xs font-semibold leading-5 text-white';

/**
 * Collection visibility badge (spec §3.5) — a dark overlay pill that sits on
 * the card thumbnail's top-left (locked mock `.vbadge`): studio-visible, or
 * private with a lock icon. The card positions it absolutely.
 *
 * Collections only. Projects dropped the visibility concept on 2026-08-07 —
 * the column and the filter survive, but nobody chooses a value and the card
 * says nothing, so ProjectCard no longer renders this.
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
        itemRole === 'owner' ? 'rounded-chrome text-foreground' : 'rounded-chrome'
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
