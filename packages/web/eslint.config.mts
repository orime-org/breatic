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
import noRelativeImportPaths from 'eslint-plugin-no-relative-import-paths';
import jsdoc from 'eslint-plugin-jsdoc';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Function-definition format spec (docs/coding-standards.md). web has its own
// ESLint 9 config, so the same jsdoc rule set declared in the root
// eslint.config.mjs is repeated here. recommended-typescript-error: param/
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
      'no-relative-import-paths': noRelativeImportPaths,
    },
    rules: {
      // React rules
      'react/prop-types': 'off',
      'react/display-name': 'off',
      'react/no-string-refs': 'off',
      'react/jsx-no-comment-textnodes': 'off',
      'react/no-unescaped-entities': 'off',
      'react/react-in-jsx-scope': 'off', // React 17+ 不再需要导入 React
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

      // Variables
      'no-unused-vars': 'off', // 使用 TypeScript ESLint 的规则代替
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn', // 警告使用 any 类型
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

      // Import path style — full migration to @/ alias for ALL imports
      // (no `../` and no `./`). Plugin auto-fixes most violations.
      // tsconfig.json `paths.@/* → src/*`. Choice B per DD
      // orime-org/breatic-inner-design#152: allowSameFolder=false means
      // even sibling `./Foo` imports rewrite to `@/path/Foo`.
      'no-relative-import-paths/no-relative-import-paths': [
        'error',
        { allowSameFolder: false, rootDir: 'src', prefix: '@' },
      ],
    },
  },
  {
    // Function-definition format spec (docs/coding-standards.md). Same rule
    // set as the root eslint.config.mjs jsdoc block: every named function unit
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
];
