// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0
import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";
import { createRule } from "#rules/create-rule";

/** Tags that open a raw query in the postgres driver. */
const RAW_TAGS = new Set(["sql", "rawPg"]);

/** Query builders that read or write table data. */
const DATA_METHODS = new Set(["select", "insert", "update", "delete"]);

/**
 * Handles that carry table access: the client and a transaction from it.
 *
 * `db.transaction` itself is absent on purpose — a service owns the
 * atomicity boundary and hands the transaction to repos, and forbidding
 * that would push transactions into a single repo when a transaction spans
 * tables. What the handle must not do is run the query itself.
 */
const DATABASE_HANDLES = new Set(["db", "tx", "trx", "yjsDb"]);

/**
 * A table's SQL lives in that table's repo and nowhere else.
 *
 * One table, one repo home. The drift this exists to prevent already
 * happened once: the project-role query existed both in the server's auth
 * service and as a hand-rolled copy in collab, and the two answers came
 * apart. Keeping every query in a `*.repo.ts` file means a table's access
 * cannot scatter across services again.
 *
 * Forbidden here: the driver's raw template, and the query builders that
 * read or write rows. Allowed: `db.transaction`, because the boundary
 * belongs to the service and the repos it calls still do the SQL.
 *
 * Reading the tree rather than the text closes two holes the shell guard
 * had. A transaction handle reaches the same tables the same way, and the
 * text scan matched the literal `db.` so `tx.insert` walked past it. And
 * comments are not in the tree at all, where the shell version needed its
 * own comment stripper — one carrying the blank-line bug this repository
 * fixed everywhere else.
 */
export const noRawSqlOutsideRepo = createRule<
  [],
  "rawTemplate" | "queryBuilder"
>({
  name: "no-raw-sql-outside-repo",
  meta: {
    type: "problem",
    docs: {
      description: "Table access lives in that table's repo module",
    },
    schema: [],
    messages: {
      rawTemplate:
        "Raw SQL outside a repo module. A table's queries live in its own `*.repo.ts` — one table, one repo home — so the same query cannot end up written twice and drifting.",
      queryBuilder:
        "`{{handle}}.{{method}}` reads or writes table data outside a repo module. Call the table's repo instead; `{{handle}}.transaction` stays here and hands the transaction to it.",
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      TaggedTemplateExpression(node: TSESTree.TaggedTemplateExpression): void {
        if (node.tag.type !== AST_NODE_TYPES.Identifier) return;
        if (!RAW_TAGS.has(node.tag.name)) return;
        context.report({ node, messageId: "rawTemplate" });
      },
      MemberExpression(node: TSESTree.MemberExpression): void {
        if (node.computed) return;
        if (node.object.type !== AST_NODE_TYPES.Identifier) return;
        if (node.property.type !== AST_NODE_TYPES.Identifier) return;
        if (!DATABASE_HANDLES.has(node.object.name)) return;
        if (!DATA_METHODS.has(node.property.name)) return;
        context.report({
          node,
          messageId: "queryBuilder",
          data: { handle: node.object.name, method: node.property.name },
        });
      },
    };
  },
});
