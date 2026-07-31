// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0
import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";
import { createRule } from "#rules/create-rule";

/**
 * Whether the node is the string `"*"`, on its own or as an array's only
 * meaningful entry — both forms the guard's regex accepted.
 * @param node The value assigned to an `origin` key.
 * @returns True when the value allows every origin.
 */
function isWildcardOrigin(node: TSESTree.Node): boolean {
  if (node.type === AST_NODE_TYPES.Literal) return node.value === "*";
  if (node.type === AST_NODE_TYPES.ArrayExpression) {
    return node.elements.some(
      (el) => el?.type === AST_NODE_TYPES.Literal && el.value === "*",
    );
  }
  return false;
}

/**
 * A wildcard origin and credentialed CORS must never ship together.
 *
 * With `credentials: true` the browser sends the session cookie on
 * cross-origin requests, so `Access-Control-Allow-Origin` has to name one
 * origin. Answering `*` alongside credentials means any site a user visits
 * can call our API as that user. The CORS specification rejects the pair
 * outright, so the practical failure is either a broken app or — if a
 * framework "helpfully" echoes the caller's origin instead — a wide-open
 * one.
 *
 * The check is per file rather than per object: a config assembled across
 * two objects is the same shipped behaviour, and for a security rule a
 * false positive costs a comment while a miss costs the session.
 */
export const noCorsWildcardCredentials = createRule({
  name: "no-cors-wildcard-credentials",
  meta: {
    type: "problem",
    docs: {
      description:
        "A wildcard CORS origin must not be combined with credentials",
    },
    schema: [],
    messages: {
      wildcardWithCredentials:
        "A wildcard CORS origin ships in the same file as `credentials: true` — name the allowed origins explicitly, or any site a user visits can call this API as that user.",
    },
  },
  defaultOptions: [],
  create(context) {
    const wildcardOrigins: TSESTree.Property[] = [];
    let sawCredentials = false;

    return {
      "Property[key.name='origin']"(node: TSESTree.Property): void {
        if (isWildcardOrigin(node.value)) wildcardOrigins.push(node);
      },
      "Property[key.name='credentials'][value.value=true]"(): void {
        sawCredentials = true;
      },
      // Decided at the end of the file: the two halves can sit in separate
      // objects, and either may be written first.
      "Program:exit"(): void {
        if (!sawCredentials) return;
        for (const node of wildcardOrigins) {
          context.report({ node, messageId: "wildcardWithCredentials" });
        }
      },
    };
  },
});
