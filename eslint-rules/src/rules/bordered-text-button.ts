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

/**
 * The sizes whose allowance rests on the button showing no word.
 *
 * `icon` and `chrome` are square glyph forms whose label lives in
 * `aria-label`, off screen — so the allowance is checkable, and it is checked:
 * declaring one of them while rendering a word used to be the single token
 * that silenced this rule for good.
 *
 * `menu-item` is not in here because its premise — "this row sits inside a
 * dropdown" — is not something the source can be asked. A row that borrows the
 * size for its height rather than for its context therefore still passes; that
 * is a known limit, and the `bordered-button:allow` marker is where a control
 * whose frame comes from its container says so on purpose.
 */
const GLYPH_ONLY_SIZES = new Set(["icon", "chrome"]);

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
  // `variant={'ghost' as const}` is ordinary TypeScript here, not a dodge, and
  // an earlier version read straight past it into "cannot be read" — which
  // switched the rule off for that call site.
  if (
    expression.type === AST_NODE_TYPES.TSAsExpression ||
    expression.type === AST_NODE_TYPES.TSSatisfiesExpression ||
    expression.type === AST_NODE_TYPES.TSNonNullExpression
  ) {
    return constantString(expression.expression);
  }
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
 * Whether the element renders a word the reader can see.
 *
 * Bare text, a string in braces, and a call such as `t('some.key')`, which is
 * how every label here is written. An expression it cannot classify is not
 * counted — reporting a glyph button by mistake is worse than missing one,
 * because a false alarm gets the rule turned off at the call site.
 * @param element - The JSX element whose children to read.
 * @returns True when at least one child is visible text.
 */
function rendersWord(element: TSESTree.JSXElement): boolean {
  return element.children.some((child) => {
    if (child.type === AST_NODE_TYPES.JSXText) {
      return child.value.trim().length > 0;
    }
    if (child.type === AST_NODE_TYPES.JSXExpressionContainer) {
      const { expression } = child;
      if (constantString(expression) !== null) return true;
      return expression.type === AST_NODE_TYPES.CallExpression;
    }
    return false;
  });
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
    // The primitive's local name in this file. A file that renames it on the
    // way in used to opt out of the rule entirely, since the selector matched
    // the word `Button` rather than the thing it was bound to.
    const localNames = new Set<string>();

    /**
     * Whether the marker sits inside this tag rather than merely on its line.
     *
     * A comment trailing a JSX line would otherwise excuse every button that
     * line contains — the marker is meant to record one exception, not a row
     * of them. Inside the tag is also the only place a comment fits in JSX.
     * @param node - The opening element being judged.
     * @returns True when a marker lies within the tag's own span.
     */
    function markedInsideTag(node: TSESTree.JSXOpeningElement): boolean {
      // The first line carries `<Button` itself, so a trailing comment there
      // belongs to whatever precedes it, not to this tag.
      for (let l = node.loc.start.line + 1; l <= node.loc.end.line; l += 1) {
        if (allowedLines.has(l)) return true;
      }
      return false;
    }

    return {
      ImportDeclaration(node: TSESTree.ImportDeclaration): void {
        if (!String(node.source.value).endsWith("components/ui/button")) return;
        for (const spec of node.specifiers) {
          if (
            spec.type === AST_NODE_TYPES.ImportSpecifier &&
            spec.imported.type === AST_NODE_TYPES.Identifier &&
            spec.imported.name === "Button"
          ) {
            localNames.add(spec.local.name);
          }
        }
      },
      JSXOpeningElement(node: TSESTree.JSXOpeningElement): void {
        if (node.name.type !== AST_NODE_TYPES.JSXIdentifier) return;
        // `Button` by default: a file may render it without importing here
        // (a test, a story), and the import visitor may not have run yet.
        if (node.name.name !== "Button" && !localNames.has(node.name.name)) {
          return;
        }
        if (markedInsideTag(node)) return;

        const variant = readAttribute(node, "variant");
        // No variant means the default one, which fills.
        if (variant.kind !== "value" || !BORDERLESS_VARIANTS.has(variant.value)) {
          return;
        }
        const size = readAttribute(node, "size");
        if (size.kind === "unreadable") return;
        // An absent size is the default one — a 32px button built for a word.
        const named = size.kind === "value" ? size.value : "default";
        if (!AFFORDANT_SIZES.has(named)) {
          context.report({ node, messageId: "borderless" });
          return;
        }
        // The glyph sizes are allowed because there is no word to mistake for
        // prose. Check that rather than take the size's word for it.
        if (
          GLYPH_ONLY_SIZES.has(named) &&
          node.parent.type === AST_NODE_TYPES.JSXElement &&
          rendersWord(node.parent)
        ) {
          context.report({ node, messageId: "borderless" });
        }
      },
    };
  },
});
