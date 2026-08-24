// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0
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
 * Collects the lines a comment excuses.
 *
 * Several rules carry a per-line escape marker, and each one wrote the same
 * dozen lines to find it. Two copies had already drifted on when they run —
 * one collected at `create` time and one inside a `Program` visitor — which
 * is the drift that matters here, because a rule reporting before its own
 * markers are collected excuses nothing.
 *
 * A block comment spanning several lines excuses all of them: the marker
 * belongs to the passage, and a reader who wrapped their reason onto a
 * second line did not mean to narrow it.
 * @param sourceCode The linted file's source, for its comments.
 * @param marker Text that, appearing in a comment, excuses its lines.
 * @returns The 1-based line numbers the marker covers.
 */
export function allowMarkerLines(
  sourceCode: TSESLint.SourceCode,
  marker: string,
): ReadonlySet<number> {
  const lines = new Set<number>();
  for (const comment of sourceCode.getAllComments()) {
    if (!comment.value.includes(marker)) continue;
    for (
      let line = comment.loc.start.line;
      line <= comment.loc.end.line;
      line += 1
    ) {
      lines.add(line);
    }
  }
  return lines;
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
): TSESLint.RuleListener {
  return {
    Literal: (node: TSESTree.Literal): void => {
      if (typeof node.value === "string") onText(node, node.value);
    },
    TemplateElement: (node: TSESTree.TemplateElement): void =>
      onText(node, node.value.raw),
  };
}
