// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { ReactNode } from 'react';
import { render, type RenderOptions, type RenderResult } from '@testing-library/react';
import { TooltipProvider } from '@web/components/ui/tooltip';

/**
 * Supply the tooltip context owned by the application root to isolated component tests.
 * @param ui - Component tree to render.
 * @param options - Testing Library options for the render.
 * @returns The mounted component queries and lifecycle controls.
 * @throws {Error} When the rendered component fails.
 */
export function renderWithTooltips(ui: ReactNode, options?: Omit<RenderOptions, 'wrapper'>): RenderResult {
  return render(ui, { ...options, wrapper: TooltipProvider });
}
