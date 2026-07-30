// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0
import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";
import { createRule } from "#rules/create-rule";

/** The two persistent stores that share the origin's namespace. */
const STORES = new Set(["localStorage", "sessionStorage"]);

/** The methods that take a key as their first argument. */
const KEYED_METHODS = new Set(["getItem", "setItem", "removeItem"]);

/** The prefix every persisted key carries. */
const PREFIX = "breatic.";

/**
 * Reads a node's value when it is a plain string with no interpolation.
 * @param node The argument or computed property to read.
 * @returns The string, or null when the value is not fixed at author time.
 */
function literalString(node: TSESTree.Node | undefined): string | null {
  if (node?.type === AST_NODE_TYPES.Literal && typeof node.value === "string") {
    return node.value;
  }
  if (
    node?.type === AST_NODE_TYPES.TemplateLiteral &&
    node.expressions.length === 0
  ) {
    return node.quasis[0]?.value.cooked ?? null;
  }
  return null;
}

/**
 * Persisted keys carry the product's prefix.
 *
 * localStorage is shared across the whole origin: a browser extension, or
 * any future app on the same domain, reads and writes the same namespace.
 * A bare key like `rail.myStudios` can be read or clobbered by either, and
 * the corruption surfaces as wrong user state with no error anywhere.
 *
 * Only literal keys are judged. A call that passes a variable is going
 * through the central registry, which is the intended path — that is not a
 * loophole but the shape the rule is steering towards, and the registry's
 * own values are pinned by its unit test.
 *
 * Wider than the guard it replaces in three measured ways: `store["key"]`
 * reads and writes a key without calling a method, an uninterpolated
 * template literal is as fixed as a quoted string, and two accesses on one
 * line are two separate nodes rather than one line the guard reported once.
 * Narrower in one: a key inside a comment is not a key.
 *
 * Tests are exempt, in the config. A key a test passes to a hook is test
 * input, not a key the product persists — the registry holds the real ones.
 */
export const storageKeyPrefix = createRule<[], "bareKey">({
  name: "storage-key-prefix",
  meta: {
    type: "problem",
    docs: {
      description: "Persisted storage keys carry the breatic. prefix",
    },
    schema: [],
    messages: {
      bareKey:
        "'{{key}}' has no '{{prefix}}' prefix. Persisted keys share the origin with extensions and any sibling app, so a bare key can be read or clobbered by either. Add it to the storage-key registry and reference it from there.",
    },
  },
  defaultOptions: [],
  create(context) {
    /**
     * Reports the node when the key is a literal without the prefix.
     * @param node Node to report on.
     * @param key The key node to judge.
     */
    function check(node: TSESTree.Node, key: TSESTree.Node | undefined): void {
      const value = literalString(key);
      if (value === null || value.startsWith(PREFIX)) return;
      context.report({
        node,
        messageId: "bareKey",
        data: { key: value, prefix: PREFIX },
      });
    }

    return {
      CallExpression(node: TSESTree.CallExpression): void {
        const callee = node.callee;
        if (
          callee.type !== AST_NODE_TYPES.MemberExpression ||
          callee.property.type !== AST_NODE_TYPES.Identifier ||
          !KEYED_METHODS.has(callee.property.name)
        ) {
          return;
        }
        const store = callee.object;
        const storeName =
          store.type === AST_NODE_TYPES.Identifier
            ? store.name
            : store.type === AST_NODE_TYPES.MemberExpression &&
                store.property.type === AST_NODE_TYPES.Identifier
              ? store.property.name
              : "";
        if (!STORES.has(storeName)) return;
        check(node, node.arguments[0]);
      },

      MemberExpression(node: TSESTree.MemberExpression): void {
        // `store["key"]` reads and writes a key without calling a method.
        if (!node.computed) return;
        const storeName =
          node.object.type === AST_NODE_TYPES.Identifier
            ? node.object.name
            : node.object.type === AST_NODE_TYPES.MemberExpression &&
                node.object.property.type === AST_NODE_TYPES.Identifier
              ? node.object.property.name
              : "";
        if (!STORES.has(storeName)) return;
        check(node, node.property);
      },
    };
  },
});
