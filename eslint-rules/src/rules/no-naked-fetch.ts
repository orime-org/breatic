// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0
import type { TSESLint, TSESTree } from "@typescript-eslint/utils";
import { createRule } from "#rules/create-rule";

/** Objects that carry the platform `fetch` as a property. */
const GLOBAL_CARRIERS = new Set(["globalThis", "window", "self"]);

/**
 * Parent node types that put an identifier in a TypeScript type position.
 *
 * Taken as-is from ESLint's own `no-restricted-globals`, which faces exactly
 * this question and answers it with this list. Copying it whole rather than
 * keeping the entries that look relevant to `fetch` is deliberate: deciding
 * which type positions "count" is the judgement that went wrong here once
 * already, and the upstream list is the maintained answer to it.
 */
const TYPE_POSITION_PARENTS = new Set([
  "TSTypeReference",
  "TSInterfaceHeritage",
  "TSClassImplements",
  "TSTypeQuery",
  "TSQualifiedName",
]);

/**
 * Whether a reference sits in a type position rather than a value position.
 *
 * `typeof fetch` is erased before anything runs and cannot send a request, so
 * reporting it would have the guard refusing a spelling rather than an action,
 * with suppression as the caller's only recourse.
 *
 * The scope analyser cannot answer this: measured, a reference from
 * `typeof fetch` reports `isValueReference === true`, identical to a real call,
 * because `typeof X` does resolve X in the value namespace. The syntactic
 * parent is what separates them.
 * @param reference - The reference to classify.
 * @returns True when the identifier's parent is a type-position node.
 */
function isInTypePosition(reference: TSESLint.Scope.Reference): boolean {
  const parent = reference.identifier.parent as TSESTree.Node | undefined;
  return parent !== undefined && TYPE_POSITION_PARENTS.has(parent.type);
}

/**
 * Report every reference in a scope that resolves to the platform `fetch`.
 *
 * Two ways it can resolve, and both have to be walked. A file linted without
 * `fetch` in `languageOptions.globals` leaves the reference unresolved, so it
 * sits in `through`. A file linted with it gets a global variable carrying no
 * definition site, and the references hang off that instead. Walking only one
 * makes the rule depend on how the consuming config happens to declare its
 * environment, which is not something a repository invariant should hinge on.
 *
 * Both walks skip type positions — see {@link isInTypePosition}.
 * @param scope - The global scope to walk.
 * @param report - Called with each offending identifier.
 */
function reportGlobalFetchReferences(
  scope: TSESLint.Scope.Scope,
  report: (identifier: TSESTree.Identifier) => void,
): void {
  for (const reference of scope.through) {
    if (reference.identifier.name !== "fetch") continue;
    if (isInTypePosition(reference)) continue;
    report(reference.identifier as TSESTree.Identifier);
  }
  for (const variable of scope.variables) {
    // A `defs` entry means someone declared this name in source, so the
    // reference is theirs and not the platform's.
    if (variable.name !== "fetch" || variable.defs.length > 0) continue;
    for (const reference of variable.references) {
      if (isInTypePosition(reference)) continue;
      report(reference.identifier as TSESTree.Identifier);
    }
  }
}

/**
 * Ban reaching for the platform `fetch` outside the shared HTTP transport.
 *
 * Every outbound HTTP call goes through `httpRequest` in `@breatic/shared`,
 * which owns the one answer to "should this be retried, and how long do we
 * wait". Before it, that judgement was written three times and gave three
 * different answers; collapsing them was a one-off, and this rule is what
 * stops them growing back. Where `fetch` IS allowed is not this rule's
 * business — that is a `files` glob in the ESLint config, the way
 * `no-ioredis-outside-core` does it.
 *
 * The rule asks what a name RESOLVES TO rather than what a line looks like.
 * The difference is not stylistic: an earlier draft matched
 * `CallExpression[callee.name='fetch']` and, measured over the seven ways to
 * reach the global, caught three — missing every form that hands the function
 * to something else rather than calling it, which is how a bare fetch
 * realistically escapes into a third-party client. That draft also flagged a
 * locally-bound parameter named `fetch`, which is not the global at all.
 * Resolution answers both at once.
 *
 * Known edge, deliberately open: a caller who reads the property off an alias
 * (`const g = globalThis; g.fetch(...)`) is not reported. Closing it would
 * mean tracking aliases of every carrier, and the guard's job is to stop the
 * bare `fetch` somebody writes without thinking, not to beat someone working
 * around it — the entrance is rigid, the whole path is not.
 */
export const noNakedFetch: TSESLint.RuleModule<"nakedFetch", []> = createRule<
  [],
  "nakedFetch"
>({
  name: "no-naked-fetch",
  meta: {
    type: "problem",
    docs: {
      description:
        "Outbound HTTP goes through the shared transport, not the platform fetch",
    },
    schema: [],
    messages: {
      nakedFetch:
        "Use `httpRequest` from '@breatic/shared' instead of the platform `fetch` — it owns the retry judgement, and a second copy of that judgement is what this transport was built to remove.",
    },
  },
  defaultOptions: [],
  create(context) {
    /**
     * Flag one identifier that reached the platform `fetch`.
     * @param identifier - The node to underline in the report.
     */
    const report = (identifier: TSESTree.Identifier): void => {
      context.report({ node: identifier, messageId: "nakedFetch" });
    };
    return {
      "Program:exit"(): void {
        reportGlobalFetchReferences(
          context.sourceCode.scopeManager?.globalScope ??
            context.sourceCode.getScope(context.sourceCode.ast),
          report,
        );
      },
      // Both spellings of the member access, because `globalThis["fetch"]`
      // reads the same property as `globalThis.fetch` and a rule that watched
      // only the dotted form would guard punctuation rather than the rule.
      [[
        `MemberExpression[computed=false][property.name='fetch']`,
        `MemberExpression[computed=true][property.value='fetch']`,
      ].join(", ")](node: TSESTree.MemberExpression): void {
        if (
          node.object.type === "Identifier" &&
          GLOBAL_CARRIERS.has(node.object.name)
        ) {
          report(node.object);
        }
      },
    };
  },
});
