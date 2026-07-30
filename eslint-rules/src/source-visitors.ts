// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0
import {
  AST_NODE_TYPES,
  type TSESLint,
  type TSESTree,
} from "@typescript-eslint/utils";

/**
 * Builds the visitors that see every module specifier in a file.
 *
 * There are five ways to name another module and a rule about imports has
 * to watch all of them, or it guards the shape people happen to write today
 * rather than the constraint. The regex guards these rules replace read only
 * `from "..."`, so a dynamic `await import("...")` walked straight past them.
 *
 * The callback is handed the literal itself alongside the node to report on,
 * because rules generally want both: the string to judge, and the whole
 * statement to underline.
 * @param onSource Called once per string specifier found.
 * @returns A listener object to return from a rule's `create`.
 */
export function moduleSourceVisitors(
  onSource: (node: TSESTree.Node, source: TSESTree.StringLiteral) => void,
): TSESLint.RuleListener {
  /**
   * Forwards the specifier when it is a plain string literal.
   * @param node The node a report should underline.
   * @param source The specifier, absent on `export { x }` with no `from`.
   */
  function visit(
    node: TSESTree.Node,
    source: TSESTree.Node | null | undefined,
  ): void {
    if (
      source?.type === AST_NODE_TYPES.Literal &&
      typeof source.value === "string"
    ) {
      onSource(node, source);
    }
  }

  return {
    ImportDeclaration: (node: TSESTree.ImportDeclaration): void =>
      visit(node, node.source),
    ExportNamedDeclaration: (node: TSESTree.ExportNamedDeclaration): void =>
      visit(node, node.source),
    ExportAllDeclaration: (node: TSESTree.ExportAllDeclaration): void =>
      visit(node, node.source),
    ImportExpression: (node: TSESTree.ImportExpression): void =>
      visit(node, node.source),
    "CallExpression[callee.name='require']": (
      node: TSESTree.CallExpression,
    ): void => visit(node, node.arguments[0]),
  };
}

/**
 * Builds the visitors that see every string a file spells out.
 *
 * Two ways to write one — a plain literal and a template chunk — and a
 * rule that watches only the first guards the quotes people happen to use
 * rather than the string itself. Backticks are ordinary in this codebase,
 * so missing them is not a hypothetical gap.
 *
 * Template interpolation is out of scope by construction: each chunk
 * between the holes arrives separately, so a rule sees `bg-brand-` and
 * `-500` rather than the joined result. That is the right trade — judging
 * the joined result would need to evaluate the expressions, and a rule
 * that guessed at them would report on strings the program never builds.
 * @param onText Called once per literal string chunk found.
 * @returns A listener object to return from a rule's `create`.
 */
export function stringLiteralVisitors(
  onText: (node: TSESTree.Node, text: string) => void,
): Record<string, (node: never) => void> {
  return {
    Literal: (node: TSESTree.Literal): void => {
      if (typeof node.value === "string") onText(node, node.value);
    },
    TemplateElement: (node: TSESTree.TemplateElement): void =>
      onText(node, node.value.raw),
  };
}
