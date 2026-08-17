// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0
import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";
import { createRule } from "#rules/create-rule";

/**
 * Tables that legitimately have no `deleted_at`, and why.
 *
 * Every entry is an append-only record or an internal queue: nothing ever
 * soft-deletes one, so a `deleted_at` column would be a column no code
 * writes. Kept in the rule rather than in the config because each entry is
 * a judgement that needs its reasoning next to it — an allowlist with no
 * stated reason becomes a place to park violations.
 */
const NO_SOFT_DELETE: ReadonlyMap<string, string> = new Map([
  ["payments", "append-only financial record; deleting one breaks the audit trail"],
  ["creditTransactions", "append-only credit ledger; immutable accounting"],
  [
    "membershipTierChanges",
    "append-only ledger of tier moves, the same carve-out as creditTransactions above: the column on users holds the current tier and every change to it is appended here, so deleting a row leaves a history that no longer adds up to the value on the account",
  ],
  [
    "creditBalances",
    "1:1 with users (PK = user_id); its soft-delete is derived from users.deleted_at through the join in credit.repo.ts, and an own column would be a second source of truth",
  ],
  [
    "projectLifecycleOutbox",
    "internal transactional-outbox command queue, not a business entity: appended in a business tx, marked sent_at by the relay, retained as an audit trail",
  ],
  [
    "storageReclaimQueue",
    "internal work queue for the offline reclaim job: the physical object still needs reclaiming after its project is gone, so the row must not follow a project delete",
  ],
  [
    "projectLastOpened",
    "per-user upsert tracker behind the Recent feed: a row for a deleted project is filtered out by the query's join, so a leftover row is harmless. Its mutable column is last_opened_at; there is no updated_at either",
  ],
  [
    "uploadGrants",
    "single-use presign grant, consumed once by /uploaded and retained as an anti-replay marker. Nobody deletes a grant — it is spent. Same append-only carve-out as the two queues above. It was never allowlisted because the guard this rule replaces silently credited it with a deleted_at that belongs to the table below it: the token appeared in a comment past this table's closing paren, and the guard read whole line ranges rather than the table",
  ],
]);

/**
 * Reads the column names out of a `pgTable` call's second argument.
 * @param columns The AST node in the columns position.
 * @returns The declared keys and spreads, or null if not an object literal.
 */
function columnKeysOf(
  columns: TSESTree.Node | undefined,
): ReadonlySet<string> | null {
  if (columns?.type !== AST_NODE_TYPES.ObjectExpression) return null;
  const keys = new Set<string>();
  for (const property of columns.properties) {
    if (property.type === AST_NODE_TYPES.SpreadElement) {
      if (property.argument.type === AST_NODE_TYPES.Identifier) {
        keys.add(`...${property.argument.name}`);
      }
      continue;
    }
    if (property.key.type === AST_NODE_TYPES.Identifier) {
      keys.add(property.key.name);
    } else if (property.key.type === AST_NODE_TYPES.Literal) {
      keys.add(String(property.key.value));
    }
  }
  return keys;
}

/**
 * Every table carries created_at, and deleted_at unless justified.
 *
 * `created_at` has no exemption: without it there is no way to ask when a
 * row appeared, and that question comes up in every incident. `deleted_at`
 * carries the soft-delete mandate — rows are marked, never removed, so a
 * foreign key never dangles and a mistake stays recoverable.
 *
 * Reads the columns object rather than a range of lines. The guard this
 * replaces treated everything between one `pgTable(` and the next as the
 * table's own text, which credited `upload_grants` with a `deleted_at`
 * that was in fact a comment about the table below it — measured, and the
 * reason that table now appears in the allowlist with its reasoning.
 *
 * Fails closed when the columns argument is not an object literal: a guard
 * that cannot see the columns must say so, not pass.
 */
export const schemaTimestamps = createRule<
  [],
  "missingCreatedAt" | "missingDeletedAt" | "unreadableColumns"
>({
  name: "schema-timestamps",
  meta: {
    type: "problem",
    docs: {
      description: "Drizzle tables carry created_at, and deleted_at unless exempt",
    },
    schema: [],
    messages: {
      missingCreatedAt:
        "Table '{{table}}' has no created_at. Use the timestamps helper, or a standalone created_at for an append-only table.",
      missingDeletedAt:
        "Table '{{table}}' has no deleted_at. Rows are soft-deleted, never removed. If this table genuinely has nothing to soft-delete, add it to NO_SOFT_DELETE in this rule with the reason.",
      unreadableColumns:
        "Cannot read the columns of '{{table}}' — the second argument to pgTable is not an object literal, so the required timestamp columns cannot be verified.",
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      VariableDeclarator(node: TSESTree.VariableDeclarator): void {
        const init = node.init;
        if (
          init?.type !== AST_NODE_TYPES.CallExpression ||
          init.callee.type !== AST_NODE_TYPES.Identifier ||
          init.callee.name !== "pgTable" ||
          node.id.type !== AST_NODE_TYPES.Identifier
        ) {
          return;
        }

        const table = node.id.name;
        const keys = columnKeysOf(init.arguments[1]);
        if (keys === null) {
          context.report({
            node,
            messageId: "unreadableColumns",
            data: { table },
          });
          return;
        }

        if (!keys.has("createdAt") && !keys.has("...timestamps")) {
          context.report({
            node,
            messageId: "missingCreatedAt",
            data: { table },
          });
        }
        if (!keys.has("deletedAt") && !NO_SOFT_DELETE.has(table)) {
          context.report({
            node,
            messageId: "missingDeletedAt",
            data: { table },
          });
        }
      },
    };
  },
});
