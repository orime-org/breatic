// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import type * as React from 'react';
import { Link } from 'react-router-dom';

import { BrandMark } from '@web/ui/BrandMark';

/**
 * Project top-bar home logo — the 28px brand mark wrapped in a home link back
 * to Studio. The mark itself is the shared `BrandMark` atom (single source,
 * also rendered by the studio top bar); this wrapper only adds the link + its
 * accessible name.
 * @returns the brand logo as a home link wrapping the shared brand mark.
 */
export function Logo28(): React.JSX.Element {
  return (
    <Link to='/studio' aria-label='Home' className='inline-flex items-center'>
      <BrandMark size={28} />
    </Link>
  );
}
