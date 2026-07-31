// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0
import type { TSESTree } from "@typescript-eslint/utils";
import { createRule } from "#rules/create-rule";

/**
 * Collects the numeric literals of a multiplication chain.
 *
 * `7 * 24 * 60 * 60 * 1000` parses left-associatively, so the factors are
 * spread across nested BinaryExpressions rather than sitting in one list.
 * @param node Node to walk.
 * @param out Accumulator the literals are pushed into.
 */
function collectFactors(node: TSESTree.Node, out: number[]): void {
  if (node.type === "BinaryExpression" && node.operator === "*") {
    collectFactors(node.left, out);
    collectFactors(node.right, out);
    return;
  }
  if (node.type === "Literal" && typeof node.value === "number") {
    out.push(node.value);
  }
}

/**
 * How long a deferred-decision request stays live is ONE configured value,
 * never a constant or arithmetic at the call site.
 *
 * Five flows ask someone to answer later: studio invite, project invite,
 * studio transfer, project transfer, role upgrade. Four carried their own
 * `const X_TTL_DAYS = 7` plus their own `Date.now() + n * 24 * 60 * 60 * 1000`,
 * and the fifth had no expiry at all — a role-upgrade request could sit
 * pending forever. Five copies is five chances to drift, and a user cannot
 * answer "how long do I have" if it depends on which flow they are in.
 *
 * Why a rule and not the type checker: re-introducing a local constant
 * compiles perfectly. Nothing breaks until the day someone edits
 * `config/limits.yaml` and four of the five flows ignore it.
 *
 * Scope lives in the ESLint config, not here: the one blessed place is
 * `packages/server/src/config/limits.ts`, and session lifetime (a 30-day
 * session is a different concept that happens to be measured in days) stays
 * out on purpose.
 */
export const noHardcodedRequestTtl = createRule<[], "ttlConstant" | "ttlArithmetic">({
  name: "no-hardcoded-request-ttl",
  meta: {
    type: "problem",
    docs: {
      description:
        "A deferred-decision request's TTL comes from config, not from a local constant or inline day arithmetic",
    },
    schema: [],
    messages: {
      ttlConstant:
        "`{{name}}` re-introduces a per-flow request TTL. All five deferred decisions share config/limits.yaml -> deferred_request_ttl_days; read it through deferredRequestExpiry() from @server/config/limits.js.",
      ttlArithmetic:
        "A day spelled out in place is a TTL nobody can tune. Stamp expiries with deferredRequestExpiry(), or take the duration from deferredRequestTtlSeconds(), both in @server/config/limits.js.",
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      Identifier(node) {
        if (!node.name.includes("TTL_DAYS")) return;
        context.report({
          node,
          messageId: "ttlConstant",
          data: { name: node.name },
        });
      },
      BinaryExpression(node) {
        if (node.operator !== "*") return;
        // Report the whole chain once: every inner link of `a * b * c` is
        // itself a `*` BinaryExpression carrying the same factors.
        const { parent } = node;
        if (parent.type === "BinaryExpression" && parent.operator === "*") return;
        const factors: number[] = [];
        collectFactors(node, factors);
        const spellsOutADay =
          factors.includes(24) && factors.filter((n) => n === 60).length >= 2;
        if (!spellsOutADay) return;
        context.report({ node, messageId: "ttlArithmetic" });
      },
    };
  },
});
