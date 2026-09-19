// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

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

/** How a section hands its scroll container over, and takes it back. */
type ScrollerSink = (element: HTMLElement | null) => void;

/**
 * Where a section hands its scroll container up.
 *
 * The section draws the scroller, and the section's own body is what reads it
 * — a body that runs above the element exists, so the element cannot simply be
 * provided downward from where it is created. The overlay holds it instead:
 * the section reports it here, the overlay keeps it in state, and every
 * section below reads it back through {@link CreditsScrollerContext}.
 */
export const CreditsScrollerSink =
  React.createContext<ScrollerSink>(() => {});
