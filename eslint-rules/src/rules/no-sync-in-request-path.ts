// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0
import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";
import { createRule } from "#rules/create-rule";

/**
 * The blocking calls the guard this rule replaces listed by name. Kept as an
 * explicit list rather than a `Sync$` suffix match: plenty of methods end in
 * Sync without blocking the loop.
 */
const BLOCKING_CALLS = [
  "readFileSync",
  "writeFileSync",
  "appendFileSync",
  "existsSync",
  "readdirSync",
  "statSync",
  "lstatSync",
  "mkdirSync",
  "rmdirSync",
  "rmSync",
  "unlinkSync",
  "renameSync",
  "copyFileSync",
  "chmodSync",
  "realpathSync",
  "accessSync",
  "readlinkSync",
  "truncateSync",
  "openSync",
  "execSync",
  "execFileSync",
  "spawnSync",
];

/**
 * Resolves the called function's name for both `f()` and `ns.f()`.
 * @param callee The call expression's callee.
 * @returns The name if it is one of the blocking calls, otherwise null.
 */
function blockingCallName(callee: TSESTree.Node): string | null {
  const id =
    callee.type === AST_NODE_TYPES.Identifier
      ? callee
      : callee.type === AST_NODE_TYPES.MemberExpression &&
          !callee.computed &&
          callee.property.type === AST_NODE_TYPES.Identifier
        ? callee.property
        : null;
  return id && BLOCKING_CALLS.includes(id.name) ? id.name : null;
}

/**
 * Blocking filesystem and process calls must stay out of the request path.
 *
 * Node serves every request on one event loop. A synchronous call holds that
 * loop for its whole duration, so one slow disk read stalls every other
 * in-flight request — not just the one that made the call. Under load this
 * shows up as latency nobody can attribute to a single endpoint.
 *
 * Startup and configuration code is exempt through the config's ignore list:
 * blocking once before the server accepts traffic costs nothing.
 */
export const noSyncInRequestPath = createRule({
  name: "no-sync-in-request-path",
  meta: {
    type: "problem",
    docs: {
      description:
        "Synchronous filesystem and process calls must not run while serving requests",
    },
    schema: [],
    messages: {
      noSyncCall:
        "{{name}} blocks the event loop, stalling every other in-flight request. Use the promise-based API instead.",
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      // The call is what blocks, so an unused import is not reported — the
      // text-matching guard this replaces could not tell the two apart.
      CallExpression(node: TSESTree.CallExpression): void {
        const name = blockingCallName(node.callee);
        if (name !== null) {
          context.report({ node, messageId: "noSyncCall", data: { name } });
        }
      },
    };
  },
});
