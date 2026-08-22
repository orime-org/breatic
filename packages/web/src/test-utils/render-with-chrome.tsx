// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * `render`, with the app-level context a component would find in production.
 *
 * Right now that means one thing: the single `TooltipProvider`. It lives on
 * `App.tsx` and nowhere else — Radix's skip-delay grouping only works within
 * one provider instance, so components must never carry their own. Under test
 * there is no `App`, so anything rendering a `Tooltip` throws
 * "`Tooltip` must be used within `TooltipProvider`" unless the test supplies
 * one. Supplying it here keeps that knowledge in a single place instead of
 * once per test file.
 */

import * as React from 'react';
import { render, type RenderOptions, type RenderResult } from '@testing-library/react';

import { TooltipProvider } from '@web/components/ui/tooltip';

/**
 * Render inside the providers the real app mounts above every space.
 * @param ui - The element under test.
 * @param options - Passed through to Testing Library, minus `wrapper`.
 * @returns Testing Library's result, with `rerender` keeping the wrapper.
 */
export function renderWithChrome(
  ui: React.ReactElement,
  options?: Omit<RenderOptions, 'wrapper'>,
): RenderResult {
  return render(ui, { ...options, wrapper: TooltipProvider });
}
