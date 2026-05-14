import type { Config } from 'tailwindcss';

/**
 * Tailwind config — mirrors design CC tokens (inner/design/tokens.css).
 *
 * Two-tier color system per ADR 2026-05-14-token-semantic-alias-and-ci-guard (amended):
 *  - shadcn standard tokens (primary / secondary / accent / muted / destructive /
 *    border / input / ring / background / foreground / card / popover) for CTA + surfaces
 *  - design CC status scale (`--status-*`) for state signaling (selected / info /
 *    handling / locked / warning / error / success)
 *  - brand scale retained only for logo SVG (chrome禁用 via brand-guard CI)
 *
 * Value sources live in src/theme/tokens.css (mirror of inner/design/tokens.css).
 */
const config: Config = {
  content: ['./src/**/*.{js,ts,jsx,tsx}', './public/index.html'],
  darkMode: ['selector', '[data-theme="dark"]'],
  theme: {
    extend: {
      colors: {
        // shadcn standard tokens — used by primitives in src/components/ui/*
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
        background: 'var(--background)',
        foreground: 'var(--foreground)',
        border: 'var(--border)',
        input: 'var(--input)',
        ring: 'var(--ring)',

        // design CC Status scale — used by business components for state signaling
        status: {
          'selected-border': 'var(--status-selected-border)',
          'selected-ring': 'var(--status-selected-ring)',
          'info-bg': 'var(--status-info-bg)',
          'info-fg': 'var(--status-info-fg)',
          'info-border-l': 'var(--status-info-border-l)',
          'handling-border': 'var(--status-handling-border)',
          'handling-fg': 'var(--status-handling-fg)',
          'locked-border': 'var(--status-locked-border)',
          'locked-bg': 'var(--status-locked-bg)',
          'locked-fg': 'var(--status-locked-fg)',
          'warning-bg': 'var(--status-warning-bg)',
          'warning-fg': 'var(--status-warning-fg)',
          'error-bg': 'var(--status-error-bg)',
          'error-fg': 'var(--status-error-fg)',
          'error-border': 'var(--status-error-border)',
          'success-bg': 'var(--status-success-bg)',
          'success-fg': 'var(--status-success-fg)',
          'success-border': 'var(--status-success-border)',
        },

        // Neutral scale (Stone warm gray, inverts in dark mode)
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

        // Brand scale — RETAINED ONLY FOR LOGO SVG.
        // Using bg-brand-* / text-brand-* / border-brand-* elsewhere will fail brand-guard CI.
        brand: {
          50: 'var(--brand-50)',
          100: 'var(--brand-100)',
          200: 'var(--brand-200)',
          300: 'var(--brand-300)',
          400: 'var(--brand-400)',
          500: 'var(--brand-500)',
          600: 'var(--brand-600)',
          700: 'var(--brand-700)',
          800: 'var(--brand-800)',
          900: 'var(--brand-900)',
        },
      },
      borderRadius: {
        DEFAULT: 'var(--radius)',
        sm: 'var(--rounded-sm)',
        md: 'var(--rounded-md)',
        lg: 'var(--rounded-lg)',
      },
      boxShadow: {
        sm: 'var(--shadow-sm)',
        DEFAULT: 'var(--shadow)',
        md: 'var(--shadow-md)',
      },
      fontSize: {
        base: 'var(--font-size-base)',
      },
      ringColor: {
        focus: 'var(--ring-focus)',
      },
      keyframes: {
        shimmer: {
          '0%': { transform: 'translateX(-100%)' },
          '100%': { transform: 'translateX(100%)' },
        },
      },
      animation: {
        shimmer: 'shimmer 1s ease-in-out infinite',
      },
    },
  },
  plugins: [],
};

export default config;
