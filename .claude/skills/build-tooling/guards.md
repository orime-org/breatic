# Writing guards: ESLint rules and repo-lint checks

Read before adding or changing a rule in `eslint-rules/src/rules/`, a check in `repo-lint/src/checks/`, or the flat config that enables them.

## Where a guard goes

**A question about the syntax of one source file is an ESLint rule (`eslint-rules/src/rules/`); everything else is a repo-lint check (`repo-lint/src/checks/`).** "Everything else" means files ESLint never parses (SQL, YAML, shell, CSS, HTML), build output, whether a file exists, and questions about the repository as a whole. Both are TypeScript, and every rule and check has its own unit test.

Check: is this question about one file's syntax, or about the repository?

**Write a guard only when its premise is visible to static analysis of one file.** A guard that cannot see its premise judges a visible stand-in for it, and the gap between the two produces a new patch every round. "Which buttons need a border" depends on the container a button is placed in, assembled in other files at runtime, so it is decided by a person looking at the screen; `no-raw-button` judges "is this a hand-written `<button>`", which the AST shows directly.

Check: can this guard answer its question by reading this one file alone? No → leave it to review.

**When string handling starts doing a parser's job, use the parser.** Hand-written YAML reading stops at comments, a hand-made glob-to-regex makes `**` match one level, counting semicolons misreads a `DO $$` block. repo-lint already depends on `yaml`, `minimatch` and `plpgsql-parser`; for ESLint configuration, ask ESLint for the effective config instead of reading the config text.

Check: is this string processing doing the work of an existing parser?

**When a scanning guard's scope grows, its own footprint must comply too.** Its CI comments, examples and allowlist entries fall inside the new scope and will fail it.

## Testing ESLint rules

**Run every `RuleTester` case under each `globals` environment the repository lints with.** A rule that looks up globals takes different branches depending on whether the name is declared: unresolved names arrive through `scope.through`, declared globals through `scope.variables` with no `defs`. `RuleTester` declares no globals by default, while the root `eslint.config.ts` uses `globals.node` and web uses `globals.browser`. `eslint-rules/src/rules/__tests__/no-naked-fetch.test.ts` loops one case list over several testers.

**Set `sourceType` inside `languageOptions.parserOptions`.** `@typescript-eslint/rule-tester` merges its default `sourceType: 'module'` into `parserOptions`, which wins over a `sourceType` beside `globals`, so script-only behaviour (top-level `var` in the global scope) is never tested.

## Flat config

**`ignores` in a config block applies to every rule in that block.** A rule that needs its own exemption, such as allowing `*.repo.ts` for one rule only, gets a block of its own; putting it into a shared block exempts the other rules too.

**`plugins` resolve per file through the blocks that match it.** A rules-only block that reaches a file no plugin block covers fails with `could not find plugin`. Register each plugin once in a block without `files`, as `eslint.config.ts` does for `breatic`, and keep the rule blocks to rules.

**Verify which rules apply to a path with `eslint --print-config <path>`.** It accepts paths that do not exist, so an invented path tests the intended scope exactly; sampling real files can land on one that an exemption happens to cover.

Check: does every rule in this block need this block's `ignores`? One does not → split the block.
