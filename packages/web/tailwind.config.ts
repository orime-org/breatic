import type { Config } from 'tailwindcss';
import vars from './src/theme/tailwind-vars';

const config: Config = {
  content: [
    './src/**/*.{js,ts,jsx,tsx}',
    './public/index.html'
  ],
  darkMode: ['selector', '[data-theme="dark"]'], // 使用 data-theme 属性
  theme: {
    extend: {
      colors: {
        ...vars,
        // Numeric scales (mock 05 alignment, additive — semantic
        // color tokens above remain the recommended default).
        brand: {
          50:  'var(--brand-50)',
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
        neutral: {
          0:   'var(--neutral-0)',
          50:  'var(--neutral-50)',
          100: 'var(--neutral-100)',
          200: 'var(--neutral-200)',
          300: 'var(--neutral-300)',
          400: 'var(--neutral-400)',
          500: 'var(--neutral-500)',
          600: 'var(--neutral-600)',
          700: 'var(--neutral-700)',
          800: 'var(--neutral-800)',
          900: 'var(--neutral-900)',
        },
        // Neutral-First status colors — ADR 2026-05-13-canvas-neutral-first-status-colors
        // Use as: bg-status-selected, border-status-locked, text-status-error, etc.
        // Light/dark variant resolved through CSS variables in theme/{light,dark}.css.
        status: {
          selected: 'var(--status-selected)',
          handling: 'var(--status-handling)',
          locked:   'var(--status-locked)',
          warning:  'var(--status-warning)',
          error:    'var(--status-error)',
          success:  'var(--status-success)',
        },
        // shadcn/ui compat aliases — ADR 2026-05-13-component-library-shadcn-ui
        // shadcn primitives use these via bg-primary / text-primary-foreground / etc.
        // CSS vars defined in theme/{light,dark}.css resolve to project neutral tokens.
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
        background: 'var(--background)',
        foreground: 'var(--foreground)',
      },
      borderRadius: {
        base: 'var(--radius-base)',
        // Token-driven scale used by the new RechargeDialog /
        // SharePopover etc. (mock 05). Naming `sm/md/lg/xl`
        // overrides Tailwind defaults so existing `rounded-md`
        // class sites pick up the token instead of 0.375rem.
        sm: 'var(--rounded-sm)',
        md: 'var(--rounded-md)',
        lg: 'var(--rounded-lg)',
        xl: 'var(--rounded-xl)',
      },
      fontSize: {
        base: 'var(--font-size-base)',
        // Used by Tweaks debug panel (dev only) — production sets
        // --text-scale = 1, leaving this equal to 14px.
        scaled: 'calc(14px * var(--text-scale, 1))',
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
