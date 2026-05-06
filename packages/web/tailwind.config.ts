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
