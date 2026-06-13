// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import type * as React from 'react';

import type { SpaceBodyProps } from '@web/spaces';
import { useTranslation } from '@web/i18n/use-translation';

/**
 * Canvas space body — chrome-baseline mock `.canvas-area`.
 *
 * Background:
 *   - 24px dot grid (radial-gradient 1px dots in `--color-canvas-grid`) over
 *     the `--color-canvas` judge-gray work surface; light + dark auto-invert
 *     via the neutral token cascade
 *   - dot grid is painted via inline `background-image` because Tailwind
 *     can't express the `radial-gradient + solid color` composite without
 *     a custom utility, and this lives on exactly one element
 *
 * Empty state (when no nodes exist yet, M0' placeholder):
 *   - centered hint card with dashed border + content radius (`rounded-lg`)
 *   - title + sub-hint loaded via i18n (`canvas.emptyState.*`)
 *
 * The full ReactFlow + Yjs binding + node toolbar + reference chips
 * wiring lands in later PRs; this PR just gets the surface visually
 * correct so chrome layered components (LeftFloatingMenu /
 * ViewportToolbar) sit on the mock-aligned canvas.
 * @param root0 - Space body props supplied by the project space outlet.
 * @param root0.spaceId - ID of the canvas space, stamped on the root element for selectors.
 * @param root0.projectId - ID of the owning project, stamped on the root element for selectors.
 * @returns The canvas surface element (dot-grid background plus empty-state hint).
 */
export function CanvasSpace({
  spaceId,
  projectId,
}: SpaceBodyProps): React.JSX.Element {
  const t = useTranslation();
  return (
    <div
      data-testid='canvas-space'
      data-project-id={projectId}
      data-space-id={spaceId}
      className='relative h-full w-full overflow-hidden bg-canvas'
      style={{
        backgroundImage:
          'radial-gradient(circle, var(--color-canvas-grid) 1px, transparent 1px)',
        backgroundSize: '24px 24px',
        backgroundPosition: '0 0',
      }}
    >
      <div
        data-testid='canvas-empty'
        className='absolute inset-0 flex items-center justify-center text-center text-sm leading-relaxed text-muted-foreground'
      >
        <div className='max-w-[360px] rounded-lg border border-dashed border-border bg-card px-6 py-4'>
          <strong className='block text-foreground'>{t('canvas.emptyState.title')}</strong>
          <span className='text-xs text-muted-foreground'>
            {t('canvas.emptyState.hint')}
          </span>
        </div>
      </div>
    </div>
  );
}
