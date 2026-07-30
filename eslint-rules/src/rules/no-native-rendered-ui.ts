// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0
import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";
import { createRule } from "#rules/create-rule";

/** Input types whose picker the browser or OS draws. */
const NATIVE_INPUT_TYPES = new Set([
  "color",
  "date",
  "time",
  "datetime-local",
  "month",
  "week",
  "range",
]);

/** Comment marker that excuses one line. */
const ALLOW_MARKER = "native-ui:allow";

/**
 * Controls whose appearance the browser or OS draws are not used.
 *
 * A native colour swatch, date picker, range thumb or media control bar
 * looks different in every engine, and its behaviour is unspecified — the
 * scrollbar standard, for instance, covers only the width and two static
 * colours. For a creative tool that inconsistency is a product problem, not
 * a cosmetic one: the same file has to look the same to two people on
 * different browsers.
 *
 * The replacements are self-drawn: a colour picker in a popover, our Slider,
 * our Select, our MediaPlayer. A rare justified exception carries a
 * `native-ui:allow` comment on the same line with its reason.
 */
export const noNativeRenderedUi = createRule({
  name: "no-native-rendered-ui",
  meta: {
    type: "problem",
    docs: {
      description:
        "Interactive controls are self-drawn rather than rendered by the browser",
    },
    schema: [],
    messages: {
      nativeControl:
        "<{{control}}> is drawn by the browser, so it looks different in every engine. Use the self-drawn equivalent, or justify the exception with a native-ui:allow comment.",
      nativeInputType:
        "input type=\"{{type}}\" opens a picker the browser or OS draws, which differs per engine. Use the self-drawn equivalent, or justify the exception with a native-ui:allow comment.",
    },
  },
  defaultOptions: [],
  create(context) {
    const allowedLines = new Set<number>();

    /**
     * Whether the node sits on a line carrying the escape marker.
     * @param node The node about to be reported.
     * @returns True when the line is excused.
     */
    function isAllowed(node: TSESTree.Node): boolean {
      return allowedLines.has(node.loc.start.line);
    }

    return {
      Program(): void {
        for (const comment of context.sourceCode.getAllComments()) {
          if (!comment.value.includes(ALLOW_MARKER)) continue;
          for (
            let line = comment.loc.start.line;
            line <= comment.loc.end.line;
            line += 1
          ) {
            allowedLines.add(line);
          }
        }
      },
      "JSXOpeningElement[name.name='select']"(
        node: TSESTree.JSXOpeningElement,
      ): void {
        if (isAllowed(node)) return;
        context.report({
          node,
          messageId: "nativeControl",
          data: { control: "select" },
        });
      },
      "JSXOpeningElement[name.name=/^(audio|video)$/]"(
        node: TSESTree.JSXOpeningElement,
      ): void {
        // The element itself is fine; the browser-drawn control bar is not.
        const hasControls = node.attributes.some(
          (attr) =>
            attr.type === AST_NODE_TYPES.JSXAttribute &&
            attr.name.type === AST_NODE_TYPES.JSXIdentifier &&
            attr.name.name === "controls",
        );
        if (!hasControls || isAllowed(node)) return;
        context.report({
          node,
          messageId: "nativeControl",
          data: {
            control:
              node.name.type === AST_NODE_TYPES.JSXIdentifier
                ? node.name.name
                : "media",
          },
        });
      },
      "JSXAttribute[name.name='type']"(node: TSESTree.JSXAttribute): void {
        const value = node.value;
        if (value?.type !== AST_NODE_TYPES.Literal) return;
        if (typeof value.value !== "string") return;
        if (!NATIVE_INPUT_TYPES.has(value.value)) return;
        if (isAllowed(node)) return;
        context.report({
          node,
          messageId: "nativeInputType",
          data: { type: value.value },
        });
      },
    };
  },
});
