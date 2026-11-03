// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import type * as React from 'react';
import { NotFoundScreen } from '@web/components/NotFoundScreen';

/**
 * Serve unknown application routes without rewriting the requested address.
 * @returns The localized missing-page screen.
 * @throws {Error} If React cannot render the page.
 */
export default function NotFoundPage(): React.JSX.Element {
  return <main><NotFoundScreen /></main>;
}
