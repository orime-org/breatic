// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import type * as React from 'react';
import type { LucideIcon } from 'lucide-react';

import { RAIL_ICON, RAIL_ICON_BOX } from '@web/pages/studio/rail/rail-row';

interface RailIconProps {
  /** The lucide glyph this row leads with. */
  icon: LucideIcon;
}

/**
 * What a top-level rail row leads with: a glyph inside the 20px column every
 * row shares. The two parts are one component rather than two class names a
 * caller remembers to pair, because a caller who reaches for the glyph alone
 * gets a row whose label starts four short of every other row's — and nothing
 * about a bare glyph says it was supposed to sit in a column.
 * @param props - The glyph to draw.
 * @param props.icon - The lucide glyph this row leads with.
 * @returns The leading column with its glyph inside.
 */
export function RailIcon({ icon: Icon }: RailIconProps): React.JSX.Element {
  return (
    <span className={RAIL_ICON_BOX}>
      <Icon className={RAIL_ICON} />
    </span>
  );
}
