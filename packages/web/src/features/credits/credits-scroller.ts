// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import * as React from 'react';

/**
 * The panel's scroll container, for the sections that page.
 *
 * Its own module because the overlay renders the sections and the sections
 * read this: putting it on the overlay makes the two import each other.
 *
 * Null until the overlay has mounted, and outside the overlay entirely, which
 * is what stops a section from watching an element that is not there.
 */
export const CreditsScrollerContext = React.createContext<HTMLElement | null>(
  null,
);
