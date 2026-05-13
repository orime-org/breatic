import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const themeDir = join(__dirname, '..');
const lightCss = readFileSync(join(themeDir, 'light.css'), 'utf-8');
const darkCss = readFileSync(join(themeDir, 'dark.css'), 'utf-8');

describe('Neutral-First status tokens (ADR 2026-05-13)', () => {
  it.each([
    '--status-selected',
    '--status-handling',
    '--status-locked',
    '--status-warning',
    '--status-error',
    '--status-success',
  ])('%s defined in both light and dark', (token) => {
    expect(lightCss).toContain(token);
    expect(darkCss).toContain(token);
  });
});

describe('Brand alias removal (ADR 2026-05-13 Neutral-First)', () => {
  it.each(['--color-brand-base', '--color-brand-secondary'])(
    '%s no longer defined in light or dark css',
    (oldAlias) => {
      expect(lightCss).not.toMatch(new RegExp(`^\\s*${oldAlias}\\s*:`, 'm'));
      expect(darkCss).not.toMatch(new RegExp(`^\\s*${oldAlias}\\s*:`, 'm'));
    },
  );
});

describe('Logo brand identity retained', () => {
  it('--brand-500 raw scale value retained in both themes (for logo)', () => {
    expect(lightCss).toContain('--brand-500');
    expect(darkCss).toContain('--brand-500');
  });
});
