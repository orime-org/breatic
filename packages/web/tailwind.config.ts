import type { Config } from 'tailwindcss';

/**
 * Minimal Tailwind config — web v14 reset(2026-05-18)起点。
 *
 * 旧版引用 `./src/theme/tailwind-vars`(已删 by reset)+ 大量 `var(--brand-*)`
 * CSS var(tokens.css 已删)。本版回到 Tailwind 默认 + 仅保留 darkMode 选择器,
 * 后续 PR 1 加 shadcn primitives 时,会:
 *   - 引入 `src/theme/tokens.css`(neutral + status + radius)
 *   - 引入 `src/theme/shadcn-bridge.css`(ADR 14 token mapping)
 *   - extend colors / borderRadius / fontFamily 等
 *
 * 详:engineering/frontend-architecture.md
 */
const config: Config = {
  content: ['./src/**/*.{js,ts,jsx,tsx}', './public/index.html'],
  darkMode: ['selector', '[data-theme="dark"]'],
  theme: { extend: {} },
  plugins: [],
};

export default config;
