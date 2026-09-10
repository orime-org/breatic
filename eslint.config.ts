import eslint from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import jsdoc from "eslint-plugin-jsdoc";
import importPlugin from "eslint-plugin-import";
import drizzle from "eslint-plugin-drizzle";
import { breaticPlugin } from "@breatic/eslint-rules";

// eslint-plugin-jsdoc TypeScript preset (error level): enforces TSDoc-style
// doc comments. no-types stays on (TS already provides param/return/yield
// types — the codebase has 0 inline-type comments). The ONE exception is
// require-throws-type, kept ON below: exception types are the single piece of
// type info a TS signature CANNOT carry (no checked exceptions), so they live
// in the comment as `@throws {ErrorType}`. yields/next-type stay off (the
// Generator<Y,R,N> signature carries them, same as returns). Together with
// explicit-function-return-type, this realizes the function-definition format
// spec (docs/ARCHITECTURE.md → Coding standards): type info → signature; exception type →
// comment. Replaces eslint-plugin-tsdoc's all-or-nothing tsdoc/syntax warn (#850).
const jsdocTs = jsdoc.configs["flat/recommended-typescript-error"];

// Every glob here names the six packages this file can actually reach, and
// never `packages/*`. The web package carries its own flat config, so ESLint
// started there never reads this file at all — a `packages/*` glob would look
// like it governed web while governing nothing there, which is how
// no-yjs-documents-outside-repo and schema-timestamps ended up declared
// repo-wide and enforced everywhere except the one package with the largest
// source tree. A rule that should also cover web is declared in
// packages/web/eslint.config.mts as well; repo-lint's eslint-rules-enabled
// check fails the build if a glob here starts claiming web again.

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Type-aware linting: load TS project info so type-checked rules
    // (e.g. no-unnecessary-type-assertion) can run. `projectService`
    // auto-discovers the nearest package tsconfig per file.
    languageOptions: {
      // Everything this file governs runs in Node. Naming the environment is
      // what tells ESLint's scope analysis that Buffer, process and
      // setTimeout exist — without it they are undeclared names, and a doc
      // comment that links to one is reported as pointing at nothing. web
      // declares its own environment in its own config.
      globals: globals.node,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: { import: importPlugin },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      // Enforce CLAUDE.md Prohibition #12: no `var`. Block-scoped `let` /
      // `const` only — `var` hoists function-wide and leaks past the block
      // it reads as scoped to, a classic source of subtle bugs. eslint:
      // recommended does NOT enable this (it's a suggestion-category rule),
      // so it must be opt-in here. Pairs with the existing
      // @typescript-eslint/no-require-imports (Prohibition #12, require half) from the
      // tseslint recommended preset.
      "no-var": "error",
      // Ban redundant type assertions — `x as T` where TS already knows
      // x is T. A cast that does nothing is noise and can mask a real
      // type problem if the underlying type later changes.
      "@typescript-eslint/no-unnecessary-type-assertion": "error",
      // Enforce CLAUDE.md Prohibition #8 "bare catch" (machine-checkable half;
      // CI maximal-strictness guard suite, ADR 2026-06-01). An empty
      // catch body silently swallows the error — at 3am the on-call cannot
      // trace the root cause. eslint:recommended already enables no-empty,
      // but stating it explicitly with allowEmptyCatch:false pins the
      // intent against a future preset-default drift. The non-empty
      // *semantic* swallow (a catch that recovers without re-throwing /
      // returning a sentinel / logging) has no reliable text signature and
      // stays a human-review concern — see that ADR.
      "no-empty": ["error", { allowEmptyCatch: false }],
      // argsIgnorePattern / varsIgnorePattern: `_`-prefixed = intentionally
      // unused. caughtErrors:"all" is the other half of Prohibition #8: a catch that
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
    // Function-definition format spec (docs/ARCHITECTURE.md → Coding standards;
    // CLAUDE.md Prohibition #11 + its Coding-style section). Every named
    // function unit — function declaration,
    // class method, class, variable-assigned arrow / function expression —
    // must carry a TSDoc block AND an explicit return type. No public-only
    // exemption: a private helper needs docs as much as an exported one
    // (a rule is either 0 or 1 — never split one kind of thing by an
    // attribute unrelated to the rule's intent, such as visibility).
    // Inline anonymous callbacks are
    // excluded (their parent is a CallExpression, not a VariableDeclarator;
    // explicit-function-return-type uses allowExpressions for the same carve-
    // out) — they are not a named function unit. Tests are exempt per the
    // project's standing test-fixture carve-out. Type info lives in the
    // signature (no-types on); the ONLY type written in a comment is the
    // exception type via `@throws {ErrorType}` (require-throws-type: error),
    // because a TS signature cannot carry it. yields/next-type stay off — the
    // Generator<Y,R,N> signature carries them like a return type does.
    // eslint-rules/ is first-party source like any package: the guard rules
    // themselves are held to the same documentation standard they enforce.
    files: [
      "packages/{collab,core,domain,server,shared,worker}/src/**/*.{ts,tsx}",
      "eslint-rules/src/**/*.ts",
      "repo-lint/src/**/*.ts",
    ],
    ignores: ["**/*.test.{ts,tsx}", "**/*.spec.{ts,tsx}", "**/__tests__/**"],
    plugins: jsdocTs.plugins,
    rules: {
      ...jsdocTs.rules,
      "jsdoc/require-jsdoc": [
        "error",
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
            "VariableDeclarator > ArrowFunctionExpression",
            "VariableDeclarator > FunctionExpression",
            "PropertyDefinition > ArrowFunctionExpression",
            "PropertyDefinition > FunctionExpression",
          ],
        },
      ],
      // Every doc block must carry a one-line summary description, not just
      // tags — a bare @param/@returns block is incomplete (a rule is either
      // 0 or 1; the summary is not an optional carve-out). The #850 cleanup added
      // summaries everywhere, so this holds at zero violations.
      "jsdoc/require-description": "error",
      // Exception type → comment (signature can't carry it). The braces in
      // `@throws {AppError}` are the one place a type belongs in a doc tag.
      "jsdoc/require-throws-type": "error",
      // Generator yield/next types are carried by the Generator<Y,R,N>
      // signature, same as a return type — not duplicated in the comment.
      "jsdoc/require-yields-type": "off",
      "jsdoc/require-next-type": "off",
      // Every named function unit declares its return type in the signature;
      // generators write Generator<Y,R,N>. allowExpressions exempts inline
      // anonymous callbacks (arr.map(x => x*2), event handlers), mirroring the
      // require-jsdoc carve-out for non-named-unit functions.
      "@typescript-eslint/explicit-function-return-type": [
        "error",
        { allowExpressions: true },
      ],
    },
  },
  {
    // Drizzle financial-safety guardrail (CI maximal-strictness guard
    // suite, ADR 2026-06-01). A db.delete() / db.update() without a
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
    // Naming guardrail for the shared cross-end contract types (2026-06-15).
    // Internal data-contract fields must be camelCase — a snake_case field
    // (the old `cover_url`) is a naming outlier that silently drifts front vs
    // back. The ONLY whitelist is the external-API field names we mirror
    // verbatim (OpenAI / ai-sdk message format: `tool_calls` / `tool_call_id`).
    // Scoped to types/ (the contract layer) only; HTTP request/response schemas
    // and provider params legitimately use snake_case and live outside this dir.
    files: ["packages/shared/src/types/**/*.ts"],
    rules: {
      "@typescript-eslint/naming-convention": [
        "error",
        {
          selector: ["objectLiteralProperty", "typeProperty"],
          format: ["camelCase"],
          filter: { regex: "^(tool_calls|tool_call_id)$", match: false },
        },
      ],
    },
  },
  {
    // Two files here are verbatim mirrors of a backend YAML file's snake_case
    // keys: model-catalog (`cost_per_call` / `display_name` / `three_d` /
    // `model_id` / `max_items` / `generation_time`) and the membership
    // ceilings (`team_studios` / `projects_per_studio` / `concurrent_editors`
    // / `studio_members` / `project_members` / `storage_bytes`, the keys of
    // `config/membership.yaml`). Unlike other shared contracts they are
    // drift-safe by construction — the front and back mirror the SAME keys, so
    // there is no camelCase-vs-snake_case split to drift. Renaming them to
    // camelCase would introduce exactly the translation step the guardrail
    // exists to prevent. They are therefore exempt from the camelCase
    // guardrail above (same rationale as the `tool_calls` whitelist), scoped
    // to just these files + their tests so the rest of types/ stays strictly
    // camelCase. Both formats are allowed so typos in other shapes are still
    // caught.
    files: [
      "packages/shared/src/types/model-catalog.ts",
      "packages/shared/src/types/__tests__/model-catalog.schema.test.ts",
      "packages/shared/src/types/membership.ts",
    ],
    rules: {
      "@typescript-eslint/naming-convention": [
        "error",
        {
          selector: ["objectLiteralProperty", "typeProperty"],
          format: ["camelCase", "snake_case"],
        },
      ],
    },
  },
  {
    // Register the guard plugin once, unscoped. In flat config `plugins`
    // resolves per file through the blocks that match it, not globally — a
    // rules-only block whose scope reaches a file no plugin block covers
    // fails with "could not find plugin". Declaring it here keeps every
    // guard block below to rules alone.
    plugins: { breatic: breaticPlugin },
  },
  {
    // Repository invariants, one rule id per guard (eslint-rules/). These
    // replace the bash scripts under scripts/: an AST match cannot be fooled
    // by the same text appearing inside a string or a comment, and it reports
    // the line the violation is actually on.
    //
    // Library packages own no process-lifecycle decision — see the rule's own
    // docs for why. Tests are exempt under the standing test carve-out.
    files: ["packages/{core,shared,domain}/src/**/*.ts"],
    ignores: ["**/__tests__/**", "**/*.test.ts", "**/*.spec.ts"],
    rules: {
      "breatic/no-library-process-exit": "error",
      "breatic/no-library-env-access": "error",
    },
  },
  {
    // Same library scope, one extra exemption: the logger module defines the
    // primitives the rule keeps out of everything else. A separate block is
    // the only way to vary `ignores` per rule — within one block, ignores
    // applies to every rule the block declares.
    files: ["packages/{core,shared,domain}/src/**/*.ts"],
    ignores: [
      "**/__tests__/**",
      "**/*.test.ts",
      "**/*.spec.ts",
      "**/logger.ts",
    ],
    rules: {
      "breatic/no-library-logger": "error",
    },
  },
  {
    // Infrastructure clients are core's to construct — it is the one place
    // that sets pool lifetime, idle timeout, keepalive and reconnect
    // behaviour. core itself is absent from this scope for that reason.
    // web is covered by its own config, which imports the same plugin.
    files: [
      "packages/{shared,server,worker,collab,domain}/src/**/*.{ts,tsx}",
    ],
    ignores: ["**/__tests__/**", "**/*.test.ts", "**/*.spec.ts"],
    rules: {
      "breatic/no-postgres-outside-core": "error",
      "breatic/no-ioredis-outside-core": "error",
    },
  },
  {
    // Every package, because a leaked row type is a problem wherever it
    // surfaces. Repos get their own block for the one exemption they need —
    // mapping the row is their job — because `ignores` applies to every rule
    // in a block, and neither of the two rules below should stop at a repo.
    //
    // The whole package, not just src/: the shell guard this replaced ran
    // `find packages -name '*.ts'`, and narrowing it to src/ on the way into
    // ESLint quietly dropped every file at the package root. A drizzle row
    // type leaking out of a drizzle.config.ts is the same leak.
    files: ["packages/{collab,core,domain,server,shared,worker}/**/*.{ts,tsx}"],
    ignores: [
      "**/*.repo.ts",
      "**/__tests__/**",
      "**/*.test.{ts,tsx}",
      "**/*.spec.{ts,tsx}",
    ],
    rules: {
      "breatic/no-drizzle-type-leak": "error",
    },
  },
  {
    // A route parameter asserted into a string, and a wildcard CORS origin
    // shipped with credentials, are wrong in a repo as much as anywhere — and
    // as wrong at the package root as inside src/, which is where the shell
    // guard these replaced looked and where narrowing to src/ stopped looking.
    files: ["packages/{collab,core,domain,server,shared,worker}/**/*.{ts,tsx}"],
    ignores: [
      "**/__tests__/**",
      "**/*.test.{ts,tsx}",
      "**/*.spec.{ts,tsx}",
    ],
    rules: {
      "breatic/no-param-as-string": "error",
      "breatic/no-cors-wildcard-credentials": "error",
    },
  },
  {
    // Backend only — web has no event loop shared across requests. The
    // exemptions are the paths that run before traffic arrives: startup
    // config, infrastructure wiring, catalogue and skill loaders, and the
    // agent's own filesystem sandbox, whose whole job is synchronous access.
    files: [
      "packages/{core,domain,server,worker,collab}/src/**/*.ts",
    ],
    ignores: [
      "**/__tests__/**",
      "**/*.test.ts",
      "**/*.spec.ts",
      "**/config/**",
      "**/config.ts",
      "**/infra/**",
      "**/*-loader.ts",
      "**/model-catalog/**",
      "**/providers/shared.ts",
    ],
    rules: {
      "breatic/no-sync-in-request-path": "error",
    },
  },
  {
    // yjs_documents is written by collab and by the server, so it gets one
    // repo and everyone else calls it. The repo itself and the schema that
    // defines the table are the two places the name legitimately appears.
    files: ["packages/{collab,core,domain,server,shared,worker}/src/**/*.{ts,tsx}"],
    ignores: [
      "packages/collab/src/services/yjs-documents.repo.ts",
      "packages/core/src/db/yjs-schema.ts",
      "**/__tests__/**",
      "**/*.test.{ts,tsx}",
      "**/*.spec.{ts,tsx}",
    ],
    rules: {
      "breatic/no-yjs-documents-outside-repo": "error",
    },
  },
  {
    // One table, one repo home: a table's queries live in its own repo
    // module, so the same query cannot end up written twice in two services
    // and drifting. The db layer itself legitimately touches the driver, and
    // the connectivity ping runs `SELECT 1` against no table at all.
    files: ["packages/{collab,core,domain,server}/src/**/*.ts"],
    ignores: [
      "**/*.repo.ts",
      "packages/*/src/db/**",
      "**/connectivity-check.ts",
      "**/__tests__/**",
      "**/*.test.ts",
      "**/*.spec.ts",
    ],
    rules: {
      "breatic/no-raw-sql-outside-repo": "error",
    },
  },
  {
    // Doc comments are the one thing here nothing else verifies, and the
    // documentation generator only ever sees the exported surface — which
    // is the minority of comments, since every named function carries one.
    // Every file the linter reaches, not only the ones under src: a config
    // file at a package root carries doc comments like any other, and this
    // is now the only thing that reads them — the documentation generator
    // was retired once this rule covered what it covered and more.
    files: [
      "packages/{collab,core,domain,server,shared,worker}/**/*.{ts,tsx}",
      "eslint-rules/**/*.ts",
      "repo-lint/**/*.ts",
    ],
    // Tests carry the same fixture carve-out every other documentation rule
    // here gives them: a comment in a fixture describes the fixture.
    ignores: ["**/*.test.{ts,tsx}", "**/*.spec.{ts,tsx}", "**/__tests__/**"],
    rules: {
      "breatic/doc-link-resolves": "error",
    },
  },
  {
    // collab authenticates through core. Reaching the session key or the
    // members table from here is the drift this prevents.
    files: ["packages/collab/src/**/*.ts"],
    ignores: ["**/__tests__/**", "**/*.test.ts", "**/*.spec.ts"],
    rules: {
      "breatic/no-collab-auth-primitives": "error",
    },
  },
  {
    // Where the five deferred decisions live — studio invite, project invite,
    // studio transfer, project transfer, role upgrade. Their shared TTL is
    // config/limits.yaml -> deferred_request_ttl_days, reached through
    // deferredRequestExpiry(); that helper lives in server/src/config, outside
    // this tree, so it needs no exception. Session lifetime is deliberately
    // out of scope: a 30-day session is a different concept that happens to be
    // measured in days, and sweeping it in would make this rule about day
    // arithmetic rather than about request TTLs.
    //
    // Tests are exempt because they legitimately construct arbitrary instants,
    // including deliberately-expired ones — which is exactly how the expiry
    // gate is verified.
    files: ["packages/server/src/modules/**/*.ts"],
    ignores: ["**/__tests__/**", "**/*.test.ts", "**/*.spec.ts"],
    rules: {
      "breatic/no-hardcoded-request-ttl": "error",
    },
  },
  {
    // Routes hand their body to `validate`; they never parse it themselves.
    // The three routes that did answered 500 for a request the caller simply
    // got wrong — a bare ZodError is not an AppError, so it fell past the
    // error handler's typed branches, and a truncated body threw a native
    // SyntaxError that nothing recognised either.
    //
    // The whole package rather than just routes/: the defect is reading a
    // parsed body outside the one wrapper, and that is wrong wherever it is
    // written. `req.text()` stays allowed and is what payment.ts uses — a
    // Stripe signature is computed over the bytes as sent, so parsing first
    // would destroy the thing being verified.
    //
    // Tests are exempt: they build requests rather than handle them.
    files: ["packages/server/src/**/*.ts"],
    ignores: ["**/__tests__/**", "**/*.test.ts", "**/*.spec.ts"],
    rules: {
      "breatic/no-raw-body-parse": "error",
    },
  },
  {
    // A client-facing error message is built with t(), never written inline.
    // `errorHandler` puts an AppError's message on the wire verbatim, so a
    // literal written at the throw site is a literal the user reads — in
    // English, whatever language they picked.
    //
    // All three packages that throw this family: domain and core reach a
    // client through the same handler as server does.
    //
    // Tests are exempt: they construct errors to assert on, not to send.
    files: ["packages/{server,domain,core}/src/**/*.ts"],
    ignores: ["**/__tests__/**", "**/*.test.ts", "**/*.spec.ts"],
    rules: {
      "breatic/no-untranslated-error-message": "error",
    },
  },
  {
    // Only test files, and deliberately not excluding them: this is the one
    // rule whose subject IS the test file. It reads the path rather than the
    // contents, so the block only has to put it in front of the right files.
    files: [
      "packages/{collab,core,domain,server,shared,worker}/src/**/*.{test,spec}.{ts,tsx}",
      "eslint-rules/src/**/*.{test,spec}.ts",
      "repo-lint/src/**/*.{test,spec}.ts",
    ],
    rules: {
      "breatic/test-file-location": "error",
    },
  },
  {
    // Every first-party source file, tests included — an unlicensed file is
    // unlicensed wherever it travels, and a test file travels in the repo
    // like any other. eslint-rules is first-party too, so it is in scope;
    // the shadcn vendor directory is third-party IP and must NOT carry an
    // Orime copyright, which is why it is excluded rather than merely
    // unenforced.
    files: [
      "packages/{collab,core,domain,server,shared,worker}/src/**/*.{ts,tsx}",
      "eslint-rules/src/**/*.ts",
      "repo-lint/src/**/*.ts",
    ],
    ignores: ["packages/web/src/components/ui/**"],
    rules: {
      "breatic/no-missing-license-header": "error",
    },
  },
  {
    // Tests are exempt: they are not shipped, so the resolution concern that
    // motivates the alias style does not reach them.
    files: [
      "packages/{collab,core,domain,server,shared,worker}/src/**/*.{ts,tsx}",
      "eslint-rules/src/**/*.ts",
      "repo-lint/src/**/*.ts",
    ],
    ignores: [
      "**/__tests__/**",
      "**/*.test.{ts,tsx}",
      "**/*.spec.{ts,tsx}",
    ],
    rules: {
      "breatic/no-relative-import": "error",
    },
  },
  {
    // Only the three service entries, and the rule reads the path itself so
    // the decision is testable. The other half of this invariant — that
    // these files exist at all — cannot be a rule and lives in the
    // repo-wide checks: a deleted entry is a file nothing lints.
    files: ["packages/{server,worker,collab}/src/index.ts"],
    rules: {
      "breatic/service-observability": "error",
    },
  },
  {
    // Every package, not just core's schema file: the rule only reacts to a
    // pgTable call, so a table declared somewhere new is covered the day it
    // appears rather than the day someone remembers to widen a glob.
    files: ["packages/{collab,core,domain,server,shared,worker}/src/**/*.ts"],
    ignores: ["**/__tests__/**", "**/*.test.ts", "**/*.spec.ts"],
    rules: {
      "breatic/schema-timestamps": "error",
    },
  },
  {
    // Every package: a deployed host hardcoded in the server or the worker
    // is the same mistake as one in the dev proxy, and neither reads its
    // target from source. Tests included — a test that talks to production
    // is the version of this that nobody notices until it does damage.
    files: ["packages/{collab,core,domain,server,shared,worker}/src/**/*.{ts,tsx}"],
    rules: {
      "breatic/no-deployed-host": "error",
    },
  },
  {
    // Outbound HTTP goes through the shared transport. The six packages this
    // file can reach; web declares the same rule in its own config, because
    // ESLint started there never reads this one.
    //
    // packages/shared/src/http/ is where the transport is implemented, so the
    // one remaining bare fetch lives there by definition. Exempting the
    // directory rather than the file: splitting the implementation later
    // should not require breaking the exemption open again.
    //
    // Tests are exempt on the same terms as every other invariant here, and
    // for a concrete reason too — the transport's own real-fetch.test.ts opens
    // a real port and calls the platform fetch, which is the only way to prove
    // the thing it proves.
    files: ["packages/{collab,core,domain,server,shared,worker}/src/**/*.{ts,tsx}"],
    ignores: [
      "packages/shared/src/http/**",
      "**/__tests__/**",
      "**/*.test.ts",
      "**/*.spec.ts",
    ],
    rules: {
      "breatic/no-naked-fetch": "error",
    },
  },
  {
    // `.wrangler/` is what `wrangler dev` writes while it runs — a bundle it
    // generated and its local storage. It is not ours to lint, and a machine
    // that has run the Worker locally would otherwise fail on it.
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/.wrangler/**",
      "**/*.js",
      "**/*.mjs",
    ],
  },
);
