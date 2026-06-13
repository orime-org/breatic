// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import type * as React from 'react';
import { Link } from 'react-router-dom';
import { Clock } from 'lucide-react';

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
      className={`flex h-8 items-center gap-2.5 rounded-chrome px-2 text-sm font-medium leading-none transition-colors ${
        active ? 'bg-muted text-foreground' : 'text-foreground hover:bg-accent'
      }`}
    >
      <Clock className='h-4 w-4 text-muted-foreground' />
      {label}
    </Link>
  );
}
