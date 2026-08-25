// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type * as React from 'react';
import { Link } from 'react-router-dom';
import { Clock } from 'lucide-react';

import { cn } from '@web/lib/utils';
import { RailIcon } from '@web/pages/studio/rail/RailIcon';
import {
  RAIL_ROW_CURRENT,
  RAIL_ROW_IDLE,
  RAIL_ROW_TOP,
} from '@web/pages/studio/rail/rail-row';

interface RailRecentLinkProps {
  /** Label for the Recent entry (resolved i18n). */
  label: string;
  /** Whether the Recent view is the active destination (`/studio`, no slug). */
  active: boolean;
}

/**
 * Rail "Recent" entry (spec §4.1 segment ③) — a one-click link to `/studio`,
 * the cross-studio recent landing. Highlighted (`aria-current="page"`) when it
 * is the active destination (the viewer is on `/studio` with no slug).
 * @param props the label and the active flag.
 * @param props.label the Recent entry label.
 * @param props.active whether Recent is the current destination.
 * @returns the Recent rail link.
 */
export function RailRecentLink({
  label,
  active,
}: RailRecentLinkProps): React.JSX.Element {
  return (
    <Link
      to='/studio'
      aria-current={active ? 'page' : undefined}
      // cn() rather than a template string: the current state names a weight
      // the base already set, and twMerge is what makes the later one win
      // rather than the stylesheet's ordering.
      className={cn(RAIL_ROW_TOP, active ? RAIL_ROW_CURRENT : RAIL_ROW_IDLE)}
    >
      <RailIcon icon={Clock} />
      {label}
    </Link>
  );
}
