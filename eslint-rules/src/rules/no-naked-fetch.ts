// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0
import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";
import { createRule } from "#rules/create-rule";

const GLOBAL_OBJECTS = new Set(["globalThis", "window", "global", "self"]);

/**
 * Whether a call expression is invoking the platform `fetch`.
 *
 * Matches the bare identifier and the explicit global forms. It deliberately
 * does NOT match an injected implementation such as `fetchImpl(...)` or
 * `deps.fetch(...)`: those are the transport handing its own fetch to a guard,
 * which is the arrangement this rule exists to protect.
 * @param node The call expression to classify.
 * @returns True when the callee is the platform fetch.
 */
function isPlatformFetchCall(node: TSESTree.CallExpression): boolean {
  const { callee } = node;
  if (callee.type === AST_NODE_TYPES.Identifier) return callee.name === "fetch";
  if (
    callee.type === AST_NODE_TYPES.MemberExpression &&
    !callee.computed &&
    callee.object.type === AST_NODE_TYPES.Identifier &&
    GLOBAL_OBJECTS.has(callee.object.name) &&
    callee.property.type === AST_NODE_TYPES.Identifier
  ) {
    return callee.property.name === "fetch";
  }
  return false;
}

/**
 * HTTP leaves this codebase through one transport, not through `fetch`.
 *
 * Every call site that talks to a vendor, an object store or the open web needs
 * the same four things — a per-attempt deadline, a deadline on the body, a
 * bounded replay, and one verdict about what deserves replaying. A naked
 * `fetch` has none of them, and the failure it produces is the quiet kind: a
 * request that hangs forever holds whatever was waiting on it, and no log line
 * says so.
 *
 * This is the same shape as the guards around the other single-home resources
 * here (`no-postgres-outside-core`, `no-ioredis-outside-core`,
 * `no-raw-sql-outside-repo`, `single-toast-entry`): one rule stated in prose is
 * one rule nobody notices breaking. When the unification landed, two naked
 * `fetch` calls survived it — one of them exported, tested, and with no
 * production caller at all — and both were found by reading, months later.
 * Prose does not fail a build.
 *
 * Scope is set where the rule is registered, not here: the transport itself and
 * the SSRF guard it drives are the two places a real `fetch` belongs, and tests
 * routinely stub one.
 *
 * WHAT IT DOES NOT CATCH, stated plainly so nobody mistakes it for a wall:
 * binding fetch to a name and calling the binding (`const f = fetch; f(url)`),
 * a computed member access (`globalThis["fetch"](url)`), or anything reached
 * through an alias this rule cannot see. Following a value to its origin needs
 * type information; this is a syntactic rule, and every syntactic rule in this
 * directory has the same limit.
 *
 * That is the right trade rather than a gap to apologise for. The failure this
 * guards against is the accidental one — someone writes `fetch(` because it is
 * the obvious thing to write, and nothing objects. Two deliberate lines to get
 * around a rule is no longer an accident, and no linter stops a person who has
 * decided to go around it.
 */
export const noNakedFetch = createRule({
  name: "no-naked-fetch",
  meta: {
    type: "problem",
    docs: {
      description:
        "HTTP goes through the shared transport, which is the only place a naked fetch belongs",
    },
    schema: [],
    messages: {
      nakedFetch:
        "Call `httpRequest` from @breatic/shared instead of `fetch` — a naked fetch has no timeout, no body deadline and no retry, and a request that hangs holds its caller with it.",
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      CallExpression(node: TSESTree.CallExpression): void {
        if (!isPlatformFetchCall(node)) return;
        context.report({ node, messageId: "nakedFetch" });
      },
    };
  },
});
