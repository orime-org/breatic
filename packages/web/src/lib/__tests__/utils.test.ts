// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * `cn` merges every radius the design tokens define: one it does not know
 * keeps both classes, and the CSS source order then picks the winner.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { cn } from '@web/lib/utils';

const css = readFileSync(resolve(import.meta.dirname, '../../theme/tokens.css'), 'utf8');
/** The radii Tailwind defines itself, which tailwind-merge already knows. */
const TAILWIND_RADII = new Set(['sm', 'md', 'lg', 'full']);
const radii = [...new Set([...css.matchAll(/--radius-([a-z0-9-]+[a-z0-9]):/g)].map((match) => match[1]!))].filter(
  (name) => !TAILWIND_RADII.has(name),
);

describe('cn', () => {
  it('reads the token radii', () => {
    expect(radii).toContain('chrome-sm');
  });

  it.each(radii)('lets rounded-%s replace another radius', (name) => {
    expect(cn('rounded-md', `rounded-${name}`)).toBe(`rounded-${name}`);
  });
});
