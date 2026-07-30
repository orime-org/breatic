// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0
import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";

/**
 * The levels a logger exposes.
 *
 * One list, because two rules are two sides of one policy: libraries must
 * not call these, and service entries must call one of them. Two copies
 * would let a level be added to one side and silently accepted by the
 * other.
 */
export const LOGGER_LEVELS = [
  "info",
  "warn",
  "error",
  "debug",
  "fatal",
  "trace",
] as const;

/** Fast membership test for the levels above. */
const LEVELS = new Set<string>(LOGGER_LEVELS);

/**
 * Whether an expression names a logger.
 *
 * Accepts a bare `logger` and any member ending in one — `this.logger`,
 * `deps.logger`, `ctx.logger`. That breadth is the point: a scoped, child
 * or injected logger is the shape most likely to appear inside a class or
 * a service, and a rule that only knew the bare identifier would let
 * exactly those through. The guard being replaced matched the text
 * `logger.error` anywhere, so anything narrower would be a regression.
 * @param node The object a member was accessed on.
 * @returns True when it names a logger.
 */
export function namesALogger(node: TSESTree.Node): boolean {
  if (node.type === AST_NODE_TYPES.Identifier) return /logger$/i.test(node.name);
  if (
    node.type === AST_NODE_TYPES.MemberExpression &&
    node.property.type === AST_NODE_TYPES.Identifier
  ) {
    return /logger$/i.test(node.property.name);
  }
  if (node.type === AST_NODE_TYPES.ThisExpression) return false;
  return false;
}

/**
 * Whether a member access is a call to a logging level on a logger.
 * @param node The member expression to judge.
 * @returns True for `logger.info`, `this.logger.warn`, `deps.logger.error`.
 */
export function isLoggerLevelAccess(node: TSESTree.MemberExpression): boolean {
  if (node.computed) return false;
  if (node.property.type !== AST_NODE_TYPES.Identifier) return false;
  if (!LEVELS.has(node.property.name)) return false;
  return namesALogger(node.object);
}
