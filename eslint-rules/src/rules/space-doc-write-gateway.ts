// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0
import type { TSESTree } from "@typescript-eslint/utils";
import { AST_NODE_TYPES } from "@typescript-eslint/utils";
import type { Rule } from "eslint";
import { createRule } from "#rules/create-rule";

/** One function allowed to write outside a gateway, with why. */
interface WriteException {
  file: string;
  function: string;
  reason: string;
}

/**
 * The rule's options. An array rather than a one-element tuple so a case list
 * built with `.map` type-checks against `RuleTester`.
 */
type Options = Array<{ exceptions: WriteException[] }>;

/** The calls whose callback argument is checked against the size cap. */
const GATEWAYS = new Set(["writeSpaceDoc", "runCanvasUndoBatch"]);

/** Plain function calls that write a Space document. */
const WRITE_FUNCTIONS = new Set(["writePlainTextIntoBody", "applyTimelineEdit"]);

/** A receiver segment that names an undo history, whatever the key. */
const HISTORY_SEGMENT = /history|undomanager/i;

/**
 * Looks through the wrappers that do not change what an expression refers to.
 * @param node An expression.
 * @returns The expression under any `!`, optional chain or type assertion.
 */
function unwrap(node: TSESTree.Node): TSESTree.Node {
  if (
    node.type === AST_NODE_TYPES.TSNonNullExpression ||
    node.type === AST_NODE_TYPES.ChainExpression ||
    node.type === AST_NODE_TYPES.TSAsExpression ||
    node.type === AST_NODE_TYPES.TSSatisfiesExpression ||
    node.type === AST_NODE_TYPES.TSTypeAssertion
  ) {
    return unwrap(node.expression);
  }
  return node;
}

/**
 * Reads a member's property name when it is written out.
 * @param member A member expression.
 * @returns `b` for `a.b` and `a['b']`, otherwise null.
 */
function propertyName(member: TSESTree.MemberExpression): string | null {
  if (!member.computed && member.property.type === AST_NODE_TYPES.Identifier) return member.property.name;
  if (member.computed && member.property.type === AST_NODE_TYPES.Literal && typeof member.property.value === "string") {
    return member.property.value;
  }
  return null;
}

/**
 * Names the last segment of a receiver.
 * @param node The receiver expression.
 * @returns `c` for `a.b.c` or `c`, otherwise null.
 */
function lastSegment(node: TSESTree.Node): string | null {
  const target = unwrap(node);
  if (target.type === AST_NODE_TYPES.Identifier) return target.name;
  if (target.type === AST_NODE_TYPES.MemberExpression) return propertyName(target);
  return null;
}

/**
 * Lists every named segment of a receiver's member chain.
 * @param node The receiver expression.
 * @returns `['a', 'b', 'c']` for `a.b.c`.
 */
function segments(node: TSESTree.Node): string[] {
  const target = unwrap(node);
  if (target.type === AST_NODE_TYPES.Identifier) return [target.name];
  if (target.type !== AST_NODE_TYPES.MemberExpression) return [];
  const name = propertyName(target);
  return [...segments(target.object), ...(name === null ? [] : [name])];
}

/**
 * Answers whether a `.transact` receiver is a Space document: in web every
 * `.transact` is a Yjs one except the BlockNote editor's.
 * @param node The receiver expression.
 * @returns Whether its last named segment is anything but `editor`.
 */
function isDocReceiver(node: TSESTree.Node): boolean {
  return lastSegment(node) !== "editor";
}

/**
 * Answers whether a call writes a Space document, by its syntax alone.
 * @param call The call expression.
 * @returns Whether the call is one of the write shapes.
 */
function isSpaceWrite(call: TSESTree.CallExpression): boolean {
  const callee = unwrap(call.callee);
  if (callee.type === AST_NODE_TYPES.Identifier) return WRITE_FUNCTIONS.has(callee.name);
  if (callee.type !== AST_NODE_TYPES.MemberExpression) return false;
  const name = propertyName(callee);
  if (name === "transact" && isDocReceiver(callee.object)) return true;
  if (!callee.computed) return (name === "undo" || name === "redo") && lastSegment(callee.object) !== "editor";
  return (
    name === "undo" ||
    name === "redo" ||
    (callee.property.type === AST_NODE_TYPES.Identifier && callee.property.name === "direction") ||
    segments(callee.object).some((segment) => HISTORY_SEGMENT.test(segment))
  );
}

/**
 * Answers whether a function is written as a callback argument of a gateway.
 * @param fn A function node.
 * @returns Whether its parent is `writeSpaceDoc(…, fn)` or `runCanvasUndoBatch(…, fn)`.
 */
function isGatewayCallback(fn: TSESTree.Node): boolean {
  const parent = fn.parent;
  return (
    parent?.type === AST_NODE_TYPES.CallExpression &&
    parent.callee.type === AST_NODE_TYPES.Identifier &&
    GATEWAYS.has(parent.callee.name) &&
    parent.arguments.includes(fn as TSESTree.CallExpressionArgument)
  );
}

/**
 * Names a function the way an exception entry refers to it.
 * @param fn A function node.
 * @returns The declared, assigned, method or property name, otherwise null.
 */
function functionName(fn: TSESTree.Node): string | null {
  if (fn.type === AST_NODE_TYPES.FunctionDeclaration) return fn.id?.name ?? null;
  const parent = fn.parent;
  if (parent?.type === AST_NODE_TYPES.VariableDeclarator && parent.id.type === AST_NODE_TYPES.Identifier) {
    return parent.id.name;
  }
  if (
    (parent?.type === AST_NODE_TYPES.MethodDefinition ||
      parent?.type === AST_NODE_TYPES.PropertyDefinition ||
      parent?.type === AST_NODE_TYPES.Property) &&
    !parent.computed &&
    parent.key.type === AST_NODE_TYPES.Identifier
  ) {
    return parent.key.name;
  }
  return null;
}

/** The node types that start a function body. */
const FUNCTIONS = new Set<string>([
  AST_NODE_TYPES.FunctionDeclaration,
  AST_NODE_TYPES.FunctionExpression,
  AST_NODE_TYPES.ArrowFunctionExpression,
]);

/**
 * Every write to a Space document in web sits, literally, inside a callback
 * passed to `writeSpaceDoc` or `runCanvasUndoBatch` (inner#1790).
 *
 * Those two calls are where the document size cap is checked, so a write
 * outside them can grow a Space past the cap. Web lints without type
 * information, so the write shapes are syntactic: `.transact` and `.undo()` /
 * `.redo()` on anything whose last segment is not `editor` (BlockNote's own
 * commands are covered by its ProseMirror plugin); computed calls keyed `'undo'`, `'redo'` or `direction`
 * or on a `history` / `undoManager` chain; `writePlainTextIntoBody` and
 * `applyTimelineEdit`. A named function that checks the cap another way is
 * listed in the `exceptions` option with its reason. Aliased imports, member
 * calls of the gateway and writes deferred inside its callback are not seen.
 */
const rule = createRule<Options, "outsideWriteGateway">({
  name: "space-doc-write-gateway",
  meta: {
    type: "problem",
    docs: {
      description: "Space document writes in web go through writeSpaceDoc or runCanvasUndoBatch",
    },
    schema: [
      {
        type: "object",
        properties: {
          exceptions: {
            type: "array",
            items: {
              type: "object",
              properties: {
                file: { type: "string", minLength: 1 },
                function: { type: "string", minLength: 1 },
                reason: { type: "string", pattern: "\\S" },
              },
              required: ["file", "function", "reason"],
              additionalProperties: false,
            },
          },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      outsideWriteGateway:
        "This writes a Space document outside the size-cap check. Move it into the callback of writeSpaceDoc(…) or runCanvasUndoBatch(…), or list the enclosing function in this rule's exceptions with a reason.",
    },
  },
  defaultOptions: [{ exceptions: [] }],
  create(context, [options]) {
    const exceptions = options?.exceptions ?? [];
    const filename = context.filename.replace(/\\/g, "/");
    const excepted = new Set(
      exceptions.filter((exception) => filename === exception.file || filename.endsWith(`/${exception.file}`)).map((exception) => exception.function),
    );
    return {
      CallExpression(call: TSESTree.CallExpression): void {
        if (!isSpaceWrite(call)) return;
        for (let node: TSESTree.Node | undefined = call.parent; node; node = node.parent) {
          if (!FUNCTIONS.has(node.type)) continue;
          if (isGatewayCallback(node)) return;
          const name = functionName(node);
          if (name !== null && excepted.has(name)) return;
        }
        context.report({ node: call, messageId: "outsideWriteGateway" });
      },
    };
  },
});

/**
 * The rule, typed also as ESLint's own rule module so a bare `Linter` accepts
 * it; typescript-eslint's `RuleContext` still declares the context methods
 * ESLint 9 removed, so the two types do not meet on their own.
 */
export const spaceDocWriteGateway: typeof rule & Rule.RuleModule = rule as typeof rule & Rule.RuleModule;
