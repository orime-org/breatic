// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0
import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";
import { createRule } from "#rules/create-rule";
import { allowMarkerLines } from "#rules/source-visitors";

/**
 * Comment marker that excuses one line.
 *
 * For the control whose frame is drawn by whatever encloses it — a node body
 * filling its shell, a chip inside a bordered wrapper. Those need no border of
 * their own and a variant that draws one puts a second edge inside the first,
 * yet every filling variant of the primitive also writes a hover background,
 * which some of them are forbidden to have. Same shape as `native-ui:allow`:
 * the exception is written down, greppable, and carries its reason.
 */
const ALLOW_MARKER = "bordered-button:allow";

/**
 * The variants that draw neither a border nor a filled background.
 *
 * Checked one by one against button.tsx: `default`, `secondary` and
 * `destructive` fill, `outline` and `destructive` draw a border, and these
 * three draw neither — at rest they are a coloured word.
 */
const BORDERLESS_VARIANTS = new Set(["ghost", "chrome-ghost", "link"]);

/**
 * Sizes at which a borderless button still reads as pressable.
 *
 * `menu-item` is a full-width row inside a popover, where a border around
 * each row would read as a stack of boxes rather than a menu. `icon` and
 * `chrome` are the square icon forms, where the glyph and the hit area are
 * the affordance and the label lives in `aria-label`, off screen.
 */
const AFFORDANT_SIZES = new Set(["menu-item", "icon", "chrome"]);

/** What reading a JSX attribute produced. */
type AttributeRead =
  | { kind: "absent" }
  | { kind: "unreadable" }
  | { kind: "value"; value: string };

/**
 * Find a named attribute on a JSX element, ignoring spreads.
 * @param node - The opening element to search.
 * @param name - The attribute name to find.
 * @returns The attribute, or undefined when it is not written here.
 */
function attributeNamed(
  node: TSESTree.JSXOpeningElement,
  name: string,
): TSESTree.JSXAttribute | undefined {
  return node.attributes.find(
    (a): a is TSESTree.JSXAttribute =>
      a.type === AST_NODE_TYPES.JSXAttribute &&
      a.name.type === AST_NODE_TYPES.JSXIdentifier &&
      a.name.name === name,
  );
}

/**
 * Read an expression that is a constant string, whichever way it is spelled.
 * @param expression - The expression to read.
 * @returns The string, or null when it is not statically one.
 */
function constantString(expression: TSESTree.Node): string | null {
  if (
    expression.type === AST_NODE_TYPES.Literal &&
    typeof expression.value === "string"
  ) {
    return expression.value;
  }
  // A template with no holes is the same constant written with backticks.
  if (
    expression.type === AST_NODE_TYPES.TemplateLiteral &&
    expression.expressions.length === 0 &&
    expression.quasis.length === 1
  ) {
    return expression.quasis[0]?.value.cooked ?? null;
  }
  return null;
}

/**
 * Read a JSX attribute, keeping "not written" apart from "cannot be read".
 *
 * Collapsing those two is what made an earlier version report
 * `size={compact ? 'icon' : 'chrome'}` — a legitimate icon button whose size
 * is chosen at runtime — by treating the unreadable size as the default one.
 * @param node - The opening element to read from.
 * @param name - The attribute name.
 * @returns Which of the three states this attribute is in.
 */
function readAttribute(
  node: TSESTree.JSXOpeningElement,
  name: string,
): AttributeRead {
  const attribute = attributeNamed(node, name);
  if (attribute === undefined) return { kind: "absent" };
  const value = attribute.value;
  if (value == null) return { kind: "unreadable" };
  if (value.type === AST_NODE_TYPES.JSXExpressionContainer) {
    const literal = constantString(value.expression);
    return literal === null ? { kind: "unreadable" } : { kind: "value", value: literal };
  }
  const literal = constantString(value);
  return literal === null ? { kind: "unreadable" } : { kind: "value", value: literal };
}

/**
 * A control that shows a word has to look pressable.
 *
 * Without a border or a fill it is a coloured phrase, and a reader has no way
 * to know it can be pressed — a functional failure, not a matter of taste.
 *
 * This watches the `Button` primitive only, which is enough because
 * `no-raw-button` makes it the one way to write a button. Before that
 * companion rule existed, watching the component alone was how three
 * borderless words shipped in the canvas while this reported clean.
 *
 * The size allowance is a list of what is permitted rather than a list of what
 * is banned. A ban on the one combination that existed when this was written
 * (`ghost` at `sm`) would pass the identical mistake at any other size,
 * whereas an allowlist leaves a size nobody has invented yet guarded.
 *
 * An attribute it cannot read statically is left alone on both axes rather
 * than guessed at. Extracting the variant into a module constant therefore
 * takes a call site out of reach — resolving that would mean following
 * imports, which costs more than it buys while every dynamic variant in the
 * app is an icon button.
 */
export const borderedTextButton = createRule({
  name: "bordered-text-button",
  meta: {
    type: "problem",
    docs: {
      description: "A control with a visible label looks pressable",
    },
    schema: [],
    messages: {
      borderless:
        "This button has a label but neither a border nor a fill, so it reads as plain text. Use a variant that draws one — outline, default, secondary or destructive. Borderless is only for size='menu-item' (a dropdown row) or the icon-only sizes 'icon' / 'chrome'.",
    },
  },
  defaultOptions: [],
  create(context) {
    const allowedLines = allowMarkerLines(context.sourceCode, ALLOW_MARKER);

    return {
      "JSXOpeningElement[name.name='Button']"(
        node: TSESTree.JSXOpeningElement,
      ): void {
        // Any line the opening tag spans, not just its first: a JSX tag runs
        // over several lines and the marker is written among the attributes,
        // which is the only place a comment fits inside one.
        for (let l = node.loc.start.line; l <= node.loc.end.line; l += 1) {
          if (allowedLines.has(l)) return;
        }
        const variant = readAttribute(node, "variant");
        // No variant means the default one, which fills.
        if (variant.kind !== "value" || !BORDERLESS_VARIANTS.has(variant.value)) {
          return;
        }
        const size = readAttribute(node, "size");
        if (size.kind === "unreadable") return;
        // An absent size is the default one — a 32px button built for a word.
        const named = size.kind === "value" ? size.value : "default";
        if (AFFORDANT_SIZES.has(named)) return;

        context.report({ node, messageId: "borderless" });
      },
    };
  },
});
