import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import tsdoc from "eslint-plugin-tsdoc";
import importPlugin from "eslint-plugin-import";
import noRelativeImportPaths from "eslint-plugin-no-relative-import-paths";

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Type-aware linting: load TS project info so type-checked rules
    // (e.g. no-unnecessary-type-assertion) can run. `projectService`
    // auto-discovers the nearest package tsconfig per file.
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: { tsdoc, import: importPlugin },
    rules: {
      "tsdoc/syntax": "warn",
      "@typescript-eslint/no-explicit-any": "error",
      // Enforce CLAUDE.md 禁止清单 #12: no `var`. Block-scoped `let` /
      // `const` only — `var` hoists function-wide and leaks past the block
      // it reads as scoped to, a classic source of subtle bugs. eslint:
      // recommended does NOT enable this (it's a suggestion-category rule),
      // so it must be opt-in here. Pairs with the existing
      // @typescript-eslint/no-require-imports (禁#12 require) from the
      // tseslint recommended preset.
      "no-var": "error",
      // Ban redundant type assertions — `x as T` where TS already knows
      // x is T. A cast that does nothing is noise and can mask a real
      // type problem if the underlying type later changes.
      "@typescript-eslint/no-unnecessary-type-assertion": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports" },
      ],
      // Register so per-line `// eslint-disable-next-line import/no-mutable-exports`
      // comments resolve. Rule itself is `error` — mutable exports are an
      // anti-pattern (see core/logger.ts for the single deliberate use case
      // which keeps the disable comment).
      "import/no-mutable-exports": "error",
    },
  },
  {
    // web-only: enforce `@/` alias imports (no `../` and no `./` —
    // every cross-file import goes through the alias). Configured per
    // tsconfig `paths` (`@/*` → `src/*`). See DD orime-org/
    // breatic-inner-design#152 for rationale.
    files: ["packages/web/src/**/*.{ts,tsx}"],
    plugins: { "no-relative-import-paths": noRelativeImportPaths },
    rules: {
      "no-relative-import-paths/no-relative-import-paths": [
        "error",
        { allowSameFolder: false, rootDir: "packages/web/src", prefix: "@" },
      ],
    },
  },
  {
    ignores: ["**/dist/**", "**/node_modules/**", "**/*.js", "**/*.mjs"],
  },
);
