// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * The selected look of a 3D icon button (inner#2061 visual review): a toolbar button selected is a flat filled block,
 * as on the canvas viewport toolbar; a left rail button selected keeps its small shadow, as on the canvas left menu.
 */

import * as React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

import { TooltipProvider } from '@web/components/ui/tooltip';
import { SceneIconButton } from '@web/spaces/three-d/SceneIconButton';

afterEach(() => {
  cleanup();
});

/**
 * Render one icon button.
 * @param props - Whether it is selected and whether it sits on the left rail.
 * @returns The button.
 * @throws {never} Never.
 */
function renderButton(props: { active?: boolean; rail?: boolean }): HTMLElement {
  render(<TooltipProvider><SceneIconButton label='Tasks' {...props}>T</SceneIconButton></TooltipProvider>);
  return screen.getByRole('button', { name: 'Tasks' });
}

describe('SceneIconButton selected look', () => {
  it('fills a selected toolbar button with no shadow', () => {
    const button = renderButton({ active: true });
    expect(button.className).toContain('bg-foreground');
    expect(button.className).not.toMatch(/\bshadow/);
  });

  it('keeps the small shadow on a selected left rail button', () => {
    const button = renderButton({ active: true, rail: true });
    expect(button.className).toContain('bg-foreground');
    expect(button.className).toContain('shadow-sm');
  });

  it('draws no fill and no shadow on a button that is not selected', () => {
    for (const rail of [false, true]) {
      cleanup();
      const button = renderButton({ rail });
      expect(button.className).not.toContain('bg-foreground');
      expect(button.className).not.toMatch(/\bshadow/);
    }
  });
});
