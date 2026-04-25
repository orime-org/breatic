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
      },
      borderRadius: {
        base: 'var(--radius-base)',
      },
      fontSize: {
        base: 'var(--font-size-base)',
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
