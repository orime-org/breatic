/**
 * Token sanity — verify theme/tokens.css mirrors design CC ground truth
 * (`breatic-inner/design/tokens.css`,locked by ADR 2026-05-14 amended).
 *
 * Critical-path coverage per [[feedback_industrial_quality]] §10.7:
 *  - shadcn standard tokens (CTA + surface + border + ring) present
 *  - design CC status tokens (selected / info / handling / locked /
 *    warning / error / success) present
 *  - brand scale retained (for logo SVG only)
 *  - dark variant block present
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const tokensCss = readFileSync(
  join(__dirname, '..', 'tokens.css'),
  'utf-8',
);

describe('shadcn standard tokens (ADR 14 §1A)', () => {
  it.each([
    '--primary',
    '--primary-foreground',
    '--secondary',
    '--secondary-foreground',
    '--destructive',
    '--destructive-foreground',
    '--background',
    '--foreground',
    '--card',
    '--card-foreground',
    '--popover',
    '--popover-foreground',
    '--muted',
    '--muted-foreground',
    '--accent',
    '--accent-foreground',
    '--border',
    '--input',
    '--ring',
    '--radius',
  ])('%s is defined', (token) => {
    expect(tokensCss).toMatch(new RegExp(`^\\s*${token}\\s*:`, 'm'));
  });
});

describe('design CC Status tokens (ADR 14 §1B)', () => {
  it.each([
    '--status-selected-border',
    '--status-selected-ring',
    '--ring-focus',
    '--status-info-bg',
    '--status-info-fg',
    '--status-info-border-l',
    '--status-handling-border',
    '--status-handling-fg',
    '--status-locked-border',
    '--status-locked-bg',
    '--status-locked-fg',
    '--status-warning-bg',
    '--status-warning-fg',
    '--status-error-bg',
    '--status-error-fg',
    '--status-error-border',
    '--status-success-bg',
    '--status-success-fg',
    '--status-success-border',
  ])('%s is defined', (token) => {
    expect(tokensCss).toMatch(new RegExp(`^\\s*${token}\\s*:`, 'm'));
  });
});

describe('Brand scale retained (logo only)', () => {
  it.each(['--brand-50', '--brand-500', '--brand-900', '--brand-logo-primary'])(
    '%s is defined',
    (token) => {
      expect(tokensCss).toMatch(new RegExp(`^\\s*${token}\\s*:`, 'm'));
    },
  );
});

describe('Dark mode override block present', () => {
  it('has [data-theme="dark"] block', () => {
    expect(tokensCss).toMatch(/\[data-theme="dark"\]\s*\{/);
  });

  it('dark block re-defines neutral scale (inverted)', () => {
    // Find the position of the dark block and check a token is redefined after it
    const darkBlockStart = tokensCss.indexOf('[data-theme="dark"]');
    expect(darkBlockStart).toBeGreaterThan(0);
    const darkBlock = tokensCss.slice(darkBlockStart);
    expect(darkBlock).toMatch(/--neutral-0\s*:/);
    expect(darkBlock).toMatch(/--neutral-900\s*:/);
  });
});

describe('Specific value invariants from ADR 14', () => {
  it('--primary = var(--neutral-900) (CTA neutral, not brand)', () => {
    expect(tokensCss).toMatch(/--primary\s*:\s*var\(--neutral-900\)/);
  });

  it('--ring = var(--neutral-900) (ring chrome, not status-selected)', () => {
    // ADR 14 amended explicitly: --ring uses neutral, not status-selected.
    // Caught a divergence in PR #101 (status-selected) — locked here.
    expect(tokensCss).toMatch(/--ring\s*:\s*var\(--neutral-900\)/);
  });

  it('--radius = 0.375rem (6px, = --rounded-lg)', () => {
    expect(tokensCss).toMatch(/--radius\s*:\s*0\.375rem/);
  });

  it('--status-info-bg = blue-50 (#EFF6FF) for agent banner B', () => {
    expect(tokensCss).toMatch(/--status-info-bg\s*:\s*#EFF6FF/);
  });
});
