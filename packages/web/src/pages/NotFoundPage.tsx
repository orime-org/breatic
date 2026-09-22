// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type * as React from 'react';
import { NotFoundScreen } from '@web/components/not-found-screen';

/**
 * Serve unknown application routes without rewriting the requested address.
 * @returns The localized missing-page screen.
 * @throws {Error} If React cannot render the page.
 */
export default function NotFoundPage(): React.JSX.Element {
  return <main><NotFoundScreen /></main>;
}
