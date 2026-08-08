// @ts-expect-error -- Node.js built-in, not covered by web tsconfig
import { dirname } from 'path';
// @ts-expect-error -- Node.js built-in, not covered by web tsconfig
import { fileURLToPath } from 'url';
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import pluginReact from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
// @ts-expect-error -- plugin ships its own loose flat-config types; the
// flatConfigs.recommended entry is used unchanged.
import jsxA11y from 'eslint-plugin-jsx-a11y';
import jsdoc from 'eslint-plugin-jsdoc';
import { breaticPlugin } from '@breatic/eslint-rules';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Function-definition format spec (docs/ARCHITECTURE.md → Coding standards). web has its own
// ESLint 9 config, so the same jsdoc rule set declared in the root
// eslint.config.ts is repeated here. recommended-typescript-error: param/
// return types come from the TS signature (no-types on), not the comment.
const jsdocTs = jsdoc.configs['flat/recommended-typescript-error'];

export default [
  js.configs.recommended,
  ...tseslint.configs.recommended,
  pluginReact.configs.flat.recommended,
  // a11y static lint — catches missing alt, bad aria-*, non-keyboard
  // accessible interactive elements, role typos, etc. (~80% of static
  // a11y issues). Runtime issues (e.g. Radix Missing Description) are
  // caught by vitest-axe in unit tests, not by this layer.
  jsxA11y.flatConfigs.recommended,
  {
    files: ['**/*.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.es2021,
      },
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        tsconfigRootDir: __dirname,
        ecmaFeatures: {
          jsx: true,
        },
      },
    },
    settings: {
      react: {
        version: 'detect',
      },
    },
    plugins: {
      'react-hooks': reactHooks,
    },
    rules: {
      // React rules
      'react/prop-types': 'off',
      'react/display-name': 'off',
      'react/no-string-refs': 'off',
      'react/jsx-no-comment-textnodes': 'off',
      'react/no-unescaped-entities': 'off',
      'react/react-in-jsx-scope': 'off', // React 17+ JSX transform — no import needed
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',

      // Code style
      indent: ['error', 2, { SwitchCase: 1, ignoredNodes: ['TemplateLiteral'] }],
      quotes: ['error', 'single'],
      'jsx-quotes': ['error', 'prefer-single'],
      semi: ['error', 'always'],
      'no-trailing-spaces': 'warn',
      'no-multiple-empty-lines': ['warn', { max: 2 }],
      'no-multi-spaces': 'error',
      'no-irregular-whitespace': 'error',
      'max-len': [
        'error',
        {
          code: 300,
          ignoreUrls: true,
          ignoreStrings: true,
          ignoreTemplateLiterals: true,
          ignoreRegExpLiterals: true,
        },
      ],

      // Variables — error level, matching the backend (root CLAUDE.md
      // frontend industrial-grade standard "TS strict, zero any"; rules
      // are binary 0/1, not split per package).
      'no-unused-vars': 'off', // superseded by the TypeScript ESLint rule below
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrors: 'all',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      '@typescript-eslint/no-explicit-any': 'error', // forbid any (frontend: zero any)
      'no-undef-init': 'off',
      'no-undefined': 'off',
      'no-use-before-define': 'off',

      // Best practices
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      'no-eval': 'warn',
      'no-caller': 'error',
      'no-else-return': 'error',
      'no-extend-native': 'error',
      'no-extra-bind': 'error',
      'no-floating-decimal': 'error',
      'no-implied-eval': 'error',
      'no-labels': 'error',
      'no-with': 'error',
      'no-loop-func': 'off',
      'no-native-reassign': 'error',
      'no-redeclare': 'error',
      'no-unused-expressions': 'off',
      'no-unneeded-ternary': 'error',
      'no-unreachable': 'error',
      'no-lonely-if': 'error',
      'no-inner-declarations': ['error', 'functions'],
      'func-call-spacing': ['error', 'never'],
      'no-case-declarations': 'off',

      // Spacing
      'array-bracket-spacing': ['error', 'never'],
      'arrow-body-style': 'off',
      'key-spacing': [
        'error',
        {
          beforeColon: false,
          afterColon: true,
        },
      ],
      'space-in-parens': ['error', 'never'],

      // Duplicates
      'no-dupe-keys': 'error',
      'no-dupe-args': 'error',
      'no-duplicate-case': 'error',

      // Other
      curly: 'off',
      'linebreak-style': ['off', 'unix'],

      // a11y rule tweaks (jsx-a11y plugin loaded above):
      //   - no-redundant-roles: allow `role='list'` on <ul> + `role='listitem'`
      //     on <li>. Safari WebKit drops list semantics when `list-style: none`
      //     is set (which Tailwind's reset does), so adding the explicit role
      //     is the documented workaround, not a redundancy.
      //     https://www.scottohara.me/blog/2019/01/12/lists-and-safari.html
      'jsx-a11y/no-redundant-roles': [
        'error',
        { ul: ['list'], li: ['listitem'] },
      ],
    },
  },
  {
    // Function-definition format spec (docs/ARCHITECTURE.md → Coding standards). Same rule
    // set as the root eslint.config.ts jsdoc block: every named function unit
    // needs a TSDoc block + explicit return type; type info lives in the
    // signature; only the exception type goes in `@throws {ErrorType}`.
    // shadcn vendor primitives (components/ui) and tests are exempt.
    files: ['src/**/*.{ts,tsx}'],
    ignores: [
      'src/components/ui/**',
      '**/*.test.{ts,tsx}',
      '**/*.spec.{ts,tsx}',
      '**/__tests__/**',
    ],
    plugins: jsdocTs.plugins,
    rules: {
      ...jsdocTs.rules,
      'jsdoc/require-jsdoc': [
        'error',
        {
          publicOnly: false,
          require: {
            ArrowFunctionExpression: false,
            ClassDeclaration: true,
            ClassExpression: true,
            FunctionDeclaration: true,
            FunctionExpression: false,
            MethodDefinition: true,
          },
          contexts: [
            'VariableDeclarator > ArrowFunctionExpression',
            'VariableDeclarator > FunctionExpression',
            'PropertyDefinition > ArrowFunctionExpression',
            'PropertyDefinition > FunctionExpression',
          ],
        },
      ],
      'jsdoc/require-description': 'error',
      'jsdoc/require-throws-type': 'error',
      'jsdoc/require-yields-type': 'off',
      'jsdoc/require-next-type': 'off',
      '@typescript-eslint/explicit-function-return-type': [
        'error',
        { allowExpressions: true },
      ],
    },
  },
  {
    files: ['**/*.cjs', '**/*.config.cjs', '**/*.config.js'],
    languageOptions: {
      globals: {
        ...globals.node,
      },
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'script',
      },
    },
  },
  {
    // Repository invariants, from the same plugin the root config uses — the
    // rules are defined once and imported twice, never restated by hand.
    // web has no business constructing an infrastructure client at all.
    //
    // Every repository-wide invariant has to be listed here as well as in the
    // root config, because ESLint started in this package never reads that
    // file. The two below were declared only there, under a `packages/*` glob
    // that reads as covering web and cannot: a SQL string naming those tables
    // was a build failure in six packages and silent in the seventh.
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['**/__tests__/**', '**/*.test.{ts,tsx}', '**/*.spec.{ts,tsx}'],
    plugins: { breatic: breaticPlugin },
    rules: {
      'breatic/no-postgres-outside-core': 'error',
      'breatic/no-ioredis-outside-core': 'error',
      'breatic/no-drizzle-type-leak': 'error',
      'breatic/no-param-as-string': 'error',
      'breatic/no-cors-wildcard-credentials': 'error',
      'breatic/no-yjs-documents-outside-repo': 'error',
      'breatic/schema-timestamps': 'error',
      // Outbound HTTP goes through the shared transport here too. Anything
      // aimed at our own backend uses the axios singleton; neither route is a
      // bare fetch. Declared here as well as in the root config for the reason
      // written above — a rule that lives only there governs nothing in this
      // package, which is exactly how the two rules above went unenforced.
      'breatic/no-naked-fetch': 'error',
    },
  },
  {
    // The app-level provider lives in App.tsx; the dev gallery is a separate
    // page tree and legitimately mounts its own. The vendor primitive file
    // needed an exemption from the text guard because its JSDoc examples read
    // as JSX — the AST never sees a comment, so that exemption is gone.
    files: ['src/**/*.tsx'],
    ignores: [
      'src/App.tsx',
      'src/pages/_dev/**',
      '**/__tests__/**',
      '**/*.test.tsx',
      '**/*.spec.tsx',
    ],
    plugins: { breatic: breaticPlugin },
    rules: {
      'breatic/single-tooltip-provider': 'error',
    },
  },
  {
    // The wrapper imports sonner by definition, and the Toaster surface
    // mounts it. Tests spy on sonner directly, which still exercises the
    // wrapper since it delegates.
    files: ['src/**/*.{ts,tsx}'],
    ignores: [
      'src/lib/toast.ts',
      'src/components/ui/sonner.tsx',
      'src/pages/_dev/**',
      '**/__tests__/**',
      '**/*.test.{ts,tsx}',
      '**/*.spec.{ts,tsx}',
    ],
    plugins: { breatic: breaticPlugin },
    rules: {
      'breatic/single-toast-entry': 'error',
    },
  },
  {
    // Tests included, matching the guard this replaces — it had no path
    // exclusion at all, only the black/white carve-out that lives in the
    // rule. A test asserting on a class string asserts on shipped markup.
    files: ['src/**/*.{ts,tsx}'],
    plugins: { breatic: breaticPlugin },
    rules: {
      'breatic/hover-pattern': 'error',
    },
  },
  {
    // Tests excluded, matching the guard this replaces. They assert on the
    // class strings a component produces, so the overflow utility appears
    // there as an expectation rather than as markup.
    files: ['src/**/*.{ts,tsx}'],
    ignores: [
      '**/__tests__/**',
      '**/*.test.{ts,tsx}',
      '**/*.spec.{ts,tsx}',
    ],
    plugins: { breatic: breaticPlugin },
    rules: {
      'breatic/no-inline-scrollbar': 'error',
    },
  },
  {
    // The vendor primitives are scanned too: ours are token-customised
    // rather than pristine shadcn, so the one-pixel rule applies to them.
    files: ['src/**/*.tsx'],
    ignores: ['**/__tests__/**', '**/*.test.tsx', '**/*.spec.tsx'],
    plugins: { breatic: breaticPlugin },
    rules: {
      'breatic/one-px-border': 'error',
    },
  },
  {
    // The vendor primitives are exempt here: a checked checkbox border moves
    // together with its fill, so it is part of that system rather than an
    // independent activation indicator.
    files: ['src/**/*.{ts,tsx}'],
    ignores: [
      'src/components/ui/**',
      '**/__tests__/**',
      '**/*.test.{ts,tsx}',
      '**/*.spec.{ts,tsx}',
    ],
    plugins: { breatic: breaticPlugin },
    rules: {
      'breatic/active-border': 'error',
    },
  },
  {
    // Exempt by provenance, not by directory. `components/ui/` is where the
    // shadcn primitives live, but it is not purely vendor — `password-input`
    // is ours, and exempting the whole path left the one first-party control
    // in the tree unguarded. Only the file that legitimately renders the
    // element is excused: `Button` itself. The dev gallery is listed to keep
    // this rule's scope identical to the other visual rules', not because it
    // needs the escape — it renders `Button` throughout.
    //
    // `.ts` is in scope alongside `.tsx`: `createElement('button')` is the
    // same element written without JSX, and that spelling lives in plain
    // modules. Watching only `.tsx` would leave half of this rule unreachable.
    files: ['src/**/*.{ts,tsx}'],
    ignores: [
      'src/components/ui/button.tsx',
      'src/pages/_dev/**',
      '**/__tests__/**',
      '**/*.test.{ts,tsx}',
      '**/*.spec.{ts,tsx}',
    ],
    plugins: { breatic: breaticPlugin },
    rules: {
      'breatic/no-raw-button': 'error',
    },
  },
  {
    // The dev gallery renders native controls on purpose, to show what we
    // replaced. Tests assert on markup rather than shipping it.
    //
    // `.ts` as well as `.tsx`: the same control reaches the DOM as a string
    // of markup through innerHTML, and that lives in plain modules as often
    // as in components. The guard this replaced read both.
    files: ['src/**/*.{ts,tsx}'],
    ignores: [
      'src/pages/_dev/**',
      '**/__tests__/**',
      '**/*.test.{ts,tsx}',
      '**/*.spec.{ts,tsx}',
    ],
    plugins: { breatic: breaticPlugin },
    rules: {
      'breatic/no-native-rendered-ui': 'error',
    },
  },
  {
    // Tests assert on class strings rather than shipping them.
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['**/__tests__/**', '**/*.test.{ts,tsx}', '**/*.spec.{ts,tsx}'],
    plugins: { breatic: breaticPlugin },
    rules: {
      'breatic/no-raw-design-values': 'error',
    },
  },
  {
    // The hex rule carries two more: the brand mark is a fixed logo colour,
    // and the inpaint brush works in pigment rather than UI surfaces.
    files: ['src/**/*.{ts,tsx}'],
    ignores: [
      'src/ui/BrandMark.tsx',
      'src/spaces/canvas/inpaint/**',
      'src/stores/inpaint.ts',
      '**/__tests__/**',
      '**/*.test.{ts,tsx}',
      '**/*.spec.{ts,tsx}',
    ],
    plugins: { breatic: breaticPlugin },
    rules: {
      'breatic/no-raw-hex-color': 'error',
    },
  },
  {
    // Only test files, and deliberately not excluding them: this is the one
    // rule whose subject IS the test file.
    files: ['src/**/*.{test,spec}.{ts,tsx}'],
    plugins: { breatic: breaticPlugin },
    rules: {
      'breatic/test-file-location': 'error',
    },
  },
  {
    // Tests included: an unlicensed file is unlicensed wherever it travels.
    // The shadcn vendor directory is excluded because it is third-party IP
    // and must not carry an Orime copyright — not merely because nobody
    // got around to adding one.
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['src/components/ui/**'],
    plugins: { breatic: breaticPlugin },
    rules: {
      'breatic/no-missing-license-header': 'error',
    },
  },
  {
    // Tests are exempt: they are not shipped, so the resolution concern
    // that motivates the alias style does not reach them. The vendor
    // directory is not exempt — shadcn components sit inside our build and
    // resolve like everything else.
    //
    // This replaces eslint-plugin-no-relative-import-paths, which visited
    // only ImportDeclaration (so `export { x } from './y'` walked past it)
    // and resolved its root through the working directory (so the answer
    // depended on where eslint was invoked). The alias contract that pinned
    // its `prefix` option now lives beside the rule, in eslint-rules.
    files: ['src/**/*.{ts,tsx}'],
    ignores: [
      '**/__tests__/**',
      '**/*.test.{ts,tsx}',
      '**/*.spec.{ts,tsx}',
    ],
    plugins: { breatic: breaticPlugin },
    rules: {
      'breatic/no-relative-import': 'error',
    },
  },
  {
    // Tests are exempt: a key a test hands to a hook is test input, not a
    // key the product persists. The registry holds the real ones and its
    // own unit test pins their prefixes.
    files: ['src/**/*.{ts,tsx}'],
    ignores: [
      '**/__tests__/**',
      '**/*.test.{ts,tsx}',
      '**/*.spec.{ts,tsx}',
    ],
    plugins: { breatic: breaticPlugin },
    rules: {
      'breatic/storage-key-prefix': 'error',
    },
  },
  {
    // The overlay families are listed inside the rule, so this only has to
    // put it in front of the vendor components. Tooltip is in the directory
    // and in neither family; the rule ignores it by name.
    files: ['src/components/ui/*.tsx'],
    plugins: { breatic: breaticPlugin },
    rules: {
      'breatic/overlay-surface': 'error',
    },
  },
  {
    // Every file in the package, root config files included — the dev proxy
    // is decided in proxy-targets.mts / dev-ports.mts / vite.config.mts,
    // none of which live under src/. Scoping by directory rather than by
    // filename is the point: the guard this replaces named vite.config.ts,
    // went blind when the file became .mts, and reported clean for months.
    files: ['**/*.{ts,tsx,mts,cts,js,mjs,cjs}'],
    plugins: { breatic: breaticPlugin },
    rules: {
      'breatic/no-deployed-host': 'error',
    },
  },
  {
    // Documentation links are scoped like every other doc rule in this file:
    // a test's comments are fixture prose, and components/ui is vendored
    // third-party source this repository deliberately does not restyle.
    // Declared apart from no-deployed-host above rather than beside it — a
    // deployed hostname in a test or in vendored code is still a deployed
    // hostname, so that rule keeps the wider scope.
    files: ['**/*.{ts,tsx,mts,cts,js,mjs,cjs}'],
    ignores: [
      'src/components/ui/**',
      '**/*.test.{ts,tsx}',
      '**/*.spec.{ts,tsx}',
      '**/__tests__/**',
    ],
    plugins: { breatic: breaticPlugin },
    rules: {
      'breatic/doc-link-resolves': 'error',
    },
  },
  {
    // Build output and Playwright artefacts are not ours to lint. Without
    // this the package-wide scope above would try to parse minified bundles.
    ignores: ['dist/**', 'test-results/**', 'coverage/**', 'playwright-report/**'],
  },
];
