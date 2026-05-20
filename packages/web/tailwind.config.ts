import type { Config } from 'tailwindcss';

/**
 * Tailwind v4 config for shadcn primitives + chrome UI scale — web v14.
 *
 * After Tailwind 4 migration (inner DD #154):
 *   - Color / radius / font-family / shadow tokens moved to `@theme {}`
 *     in `src/theme/tokens.css` (Tailwind 4 reads them at build time
 *     and emits utility classes with full alpha-modifier support).
 *   - This JS config only declares non-@theme-namespace tokens:
 *     custom spacing entries that map project-specific scale to
 *     utility-class names (e.g. `p-space-3` → `padding: var(--space-3)`).
 *   - Animation utilities come from `@import "tw-animate-css"` in
 *     index.css (replaces the v3 `tailwindcss-animate` plugin).
 *
 * Provenance:
 *   - shadcn alias / radius / colors: now `@theme {}` in tokens.css
 *   - chrome UI scale (space/btn/icon/avatar/radius split): chrome-baseline
 *     mock v4.x — non-@theme spacing kept here for utility-class binding
 */
const config: Config = {
  content: ['./src/**/*.{js,ts,jsx,tsx}', './public/index.html'],
  darkMode: ['selector', '[data-theme="dark"]'],
  theme: {
    extend: {
      // Spacing scale · 8pt grid (chrome v4.0).
      // Kept in JS config because `--space-N` is a discrete project
      // scale, not Tailwind 4's `--spacing` single multiplier.
      spacing: {
        'space-1': 'var(--space-1)',
        'space-2': 'var(--space-2)',
        'space-3': 'var(--space-3)',
        'space-4': 'var(--space-4)',
        'space-5': 'var(--space-5)',
        'space-6': 'var(--space-6)',
        // Button hit areas
        'btn-compact': 'var(--btn-compact)',
        'btn-inline': 'var(--btn-inline)',
        'btn-chrome': 'var(--btn-chrome)',
        'btn-menu': 'var(--btn-menu)',
        // Avatar sizes
        'avatar-xs': 'var(--avatar-xs)',
        'avatar-sm': 'var(--avatar-sm)',
        'avatar-md': 'var(--avatar-md)',
        'avatar-lg': 'var(--avatar-lg)',
        'avatar-xl': 'var(--avatar-xl)',
        // Icon sizes
        'icon-xs': 'var(--icon-xs)',
        'icon-sm': 'var(--icon-sm)',
        'icon-base': 'var(--icon-base)',
        'icon-lg': 'var(--icon-lg)',
      },
      // fontSize.base maps the Tweaks-linked base font size to a utility
      // class. The default font scale (text-xs / text-sm / text-base /
      // ...) still comes from Tailwind 4 defaults via @theme.
      fontSize: {
        base: 'var(--font-size-base)',
      },
    },
  },
};

export default config;
