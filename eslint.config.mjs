import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import tsdoc from "eslint-plugin-tsdoc";
import importPlugin from "eslint-plugin-import";
import noRelativeImportPaths from "eslint-plugin-no-relative-import-paths";
import drizzle from "eslint-plugin-drizzle";

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
      // Enforce CLAUDE.md 禁止清单 #8 "裸 catch" (machine-checkable half;
      // CI maximal-strictness guard suite, inner ADR 2026-06-01). An empty
      // catch body silently swallows the error — at 3am the on-call cannot
      // trace the root cause. eslint:recommended already enables no-empty,
      // but stating it explicitly with allowEmptyCatch:false pins the
      // intent against a future preset-default drift. The non-empty
      // *semantic* swallow (a catch that recovers without re-throwing /
      // returning a sentinel / logging) has no reliable text signature and
      // stays a human-review concern — see the inner ADR.
      "no-empty": ["error", { allowEmptyCatch: false }],
      // argsIgnorePattern / varsIgnorePattern: `_`-prefixed = intentionally
      // unused. caughtErrors:"all" is the other half of 禁#8: a catch that
      // BINDS the error (`catch (err)`) but never uses it has captured the
      // failure only to drop it — the closest machine signal for a real
      // swallow. Prefix the binding `_` (or omit it: `catch {`) when the
      // recovery genuinely does not need the error.
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrors: "all",
          caughtErrorsIgnorePattern: "^_",
        },
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
    // Drizzle financial-safety guardrail (CI maximal-strictness guard
    // suite, inner ADR 2026-06-01). A db.delete() / db.update() without a
    // .where() clause wipes or mass-mutates the ENTIRE table — catastrophic
    // for the credit / payment financial tables (a forgotten where on a
    // credit update zeroes every user's balance). Drizzle's official plugin
    // flags the missing-where call. drizzleObjectName lists the query-builder
    // handles we use: the db singleton and the transaction handle tx (so
    // tx.delete()/tx.update() inside a db.transaction are covered too).
    // Backend packages only — web has no DB access.
    files: ["packages/{server,core,domain,worker,collab}/src/**/*.ts"],
    plugins: { drizzle },
    rules: {
      "drizzle/enforce-delete-with-where": [
        "error",
        { drizzleObjectName: ["db", "tx"] },
      ],
      "drizzle/enforce-update-with-where": [
        "error",
        { drizzleObjectName: ["db", "tx"] },
      ],
    },
  },
  {
    ignores: ["**/dist/**", "**/node_modules/**", "**/*.js", "**/*.mjs"],
  },
);
