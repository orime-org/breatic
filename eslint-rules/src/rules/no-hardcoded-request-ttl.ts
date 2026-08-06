// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0
import type { TSESTree } from "@typescript-eslint/utils";
import { createRule } from "#rules/create-rule";

/** A day in seconds — the smallest unit any of these durations is built from. */
const DAY_SECONDS = 86_400;

/**
 * The constant value of a multiplication chain, when every factor is a number.
 *
 * `7 * 24 * 60 * 60 * 1000` parses left-associatively, so the factors are
 * spread across nested BinaryExpressions rather than sitting in one list.
 * Returns null as soon as a factor is anything else, because a chain with a
 * variable in it has no value to judge at lint time.
 * @param node Node to evaluate.
 * @returns The product, or null when it is not a constant.
 */
function constantProduct(node: TSESTree.Node): number | null {
  if (node.type === "BinaryExpression" && node.operator === "*") {
    const left = constantProduct(node.left);
    if (left === null) return null;
    const right = constantProduct(node.right);
    if (right === null) return null;
    return left * right;
  }
  if (node.type === "Literal" && typeof node.value === "number") {
    return node.value;
  }
  return null;
}

/**
 * Whether a constant is some whole number of days, in seconds or milliseconds.
 *
 * Judging the VALUE rather than the shape of the arithmetic is the point: an
 * hour can be written `60 * 60` or `3600`, a day `24 * 3600` or `86400000`,
 * and a rule that matches shapes only ever catches the shapes its author
 * happened to think of. Every spelling of the same duration multiplies out to
 * the same number.
 * @param value The constant to judge.
 * @returns True when it is a whole number of days.
 */
function isWholeDays(value: number): boolean {
  if (!Number.isInteger(value) || value < DAY_SECONDS) return false;
  return value % DAY_SECONDS === 0;
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
 *
 * Judging the value rather than the shape means other durations that happen to
 * be whole days land in scope too — an email-verification window is not a
 * deferred decision, and no amount of scoping by directory separates them.
 * Those carry `request-ttl:allow` with a reason on the same line. The escape
 * hatch is deliberately noisy to write and trivial to grep, which is the
 * property that keeps it rare.
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
    const source = context.sourceCode;

    /**
     * Whether this line opted out, on purpose and in the open.
     * @param node The node about to be reported.
     * @returns True when the line carries the escape hatch.
     */
    function isAllowed(node: TSESTree.Node): boolean {
      const line = source.lines[node.loc.start.line - 1];
      return line !== undefined && line.includes("request-ttl:allow");
    }

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
        const product = constantProduct(node);
        if (product === null || !isWholeDays(product)) return;
        if (isAllowed(node)) return;
        context.report({ node, messageId: "ttlArithmetic" });
      },
      Literal(node) {
        // A day written as one number is the same hardcoded TTL with the
        // arithmetic already done. Factors inside a chain are left to the
        // handler above, which judges the product they come to.
        if (typeof node.value !== "number") return;
        const { parent } = node;
        if (parent.type === "BinaryExpression" && parent.operator === "*") return;
        if (!isWholeDays(node.value)) return;
        if (isAllowed(node)) return;
        context.report({ node, messageId: "ttlArithmetic" });
      },
    };
  },
});
