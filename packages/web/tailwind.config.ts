import type { Config } from 'tailwindcss';
import animate from 'tailwindcss-animate';

/**
 * Tailwind config for shadcn primitives + chrome UI scale — web v14.
 *
 * Single token source: `src/theme/tokens.css` (consolidated 2026-05-19).
 * All entries below are var(--xxx) aliases to that file — never hard-code
 * values here or in shadcn primitives; change them in tokens.css.
 *
 * Provenance:
 *   - shadcn alias / radius / colors: ADR 14 amended
 *   - chrome UI scale (space/btn/icon/avatar/radius split): chrome-baseline
 *     mock v4.x
 *   - status palette (full 5 × 3-piece): inner design/tokens.css
 */
const config: Config = {
  content: ['./src/**/*.{js,ts,jsx,tsx}', './public/index.html'],
  darkMode: ['selector', '[data-theme="dark"]'],
  theme: {
    extend: {
      colors: {
        background: 'var(--background)',
        foreground: 'var(--foreground)',
        primary: {
          DEFAULT: 'var(--primary)',
          foreground: 'var(--primary-foreground)',
        },
        secondary: {
          DEFAULT: 'var(--secondary)',
          foreground: 'var(--secondary-foreground)',
        },
        accent: {
          DEFAULT: 'var(--accent)',
          foreground: 'var(--accent-foreground)',
        },
        muted: {
          DEFAULT: 'var(--muted)',
          foreground: 'var(--muted-foreground)',
        },
        destructive: {
          DEFAULT: 'var(--destructive)',
          foreground: 'var(--destructive-foreground)',
        },
        card: {
          DEFAULT: 'var(--card)',
          foreground: 'var(--card-foreground)',
        },
        popover: {
          DEFAULT: 'var(--popover)',
          foreground: 'var(--popover-foreground)',
        },
        border: 'var(--border)',
        input: 'var(--input)',
        ring: 'var(--ring)',
        neutral: {
          0: 'var(--neutral-0)',
          50: 'var(--neutral-50)',
          100: 'var(--neutral-100)',
          200: 'var(--neutral-200)',
          300: 'var(--neutral-300)',
          400: 'var(--neutral-400)',
          500: 'var(--neutral-500)',
          600: 'var(--neutral-600)',
          700: 'var(--neutral-700)',
          800: 'var(--neutral-800)',
          900: 'var(--neutral-900)',
          950: 'var(--neutral-950)',
        },
        // Status palette · 5 × 3-piece (bg/fg/border)
        'status-selected': {
          bg: 'var(--status-selected-bg)',
          fg: 'var(--status-selected-fg)',
          border: 'var(--status-selected-border)',
        },
        'status-info': {
          bg: 'var(--status-info-bg)',
          fg: 'var(--status-info-fg)',
          border: 'var(--status-info-border)',
        },
        'status-handling': {
          bg: 'var(--status-handling-bg)',
          fg: 'var(--status-handling-fg)',
          border: 'var(--status-handling-border)',
        },
        'status-locked': {
          bg: 'var(--status-locked-bg)',
          fg: 'var(--status-locked-fg)',
          border: 'var(--status-locked-border)',
        },
        'status-warning': {
          bg: 'var(--status-warning-bg)',
          fg: 'var(--status-warning-fg)',
          border: 'var(--status-warning-border)',
        },
        'status-error': {
          bg: 'var(--status-error-bg)',
          fg: 'var(--status-error-fg)',
          border: 'var(--status-error-border)',
        },
        'status-success': {
          bg: 'var(--status-success-bg)',
          fg: 'var(--status-success-fg)',
          border: 'var(--status-success-border)',
        },
      },
      borderRadius: {
        // shadcn-standard names (mapped to content scale in tokens.css)
        sm: 'var(--radius-sm)',
        md: 'var(--radius-md)',
        lg: 'var(--radius-lg)',
        full: 'var(--radius-full)',
        // Chrome split (chrome v4.x § F2)
        chrome: 'var(--radius-chrome)',
        'content-sm': 'var(--radius-content-sm)',
        'content-md': 'var(--radius-content-md)',
        'content-lg': 'var(--radius-content-lg)',
        'content-xl': 'var(--radius-content-xl)',
      },
      // Spacing scale · 8pt grid (chrome v4.0)
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
      fontFamily: {
        sans: ['var(--font-sans)'],
      },
      fontSize: {
        base: 'var(--font-size-base)',
      },
      boxShadow: {
        sm: 'var(--shadow-sm)',
        DEFAULT: 'var(--shadow)',
        md: 'var(--shadow-md)',
      },
    },
  },
  plugins: [animate],
};

export default config;
