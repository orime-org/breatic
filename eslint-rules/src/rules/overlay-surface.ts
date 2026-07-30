// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0
import type { TSESTree } from "@typescript-eslint/utils";
import { createRule } from "#rules/create-rule";

/**
 * Overlays that take the screen over: a backdrop plus a body of content.
 *
 * They read as a screen in a box, so they take the same surface as the
 * content cards on the page behind them.
 */
const CONTENT_PANELS = new Set(["dialog", "alert-dialog", "sheet"]);

/**
 * Overlays attached to a trigger, with no backdrop.
 *
 * They float above the page rather than replacing it, so they take the
 * distinct popover surface that separates them from page content.
 * Tooltip is absent on purpose: it is inverse (`bg-foreground`) and
 * belongs to neither family.
 */
const ANCHORED_FLOATS = new Set([
  "popover",
  "dropdown-menu",
  "context-menu",
  "select",
  "command",
  "sonner",
]);

/** Surfaces a content panel must not use. */
const NOT_ON_CONTENT_PANEL = /(^|[^a-z0-9-])bg-(popover|elevated)([^a-z0-9-]|$)/;

/** Surfaces an anchored float must not use. */
const NOT_ON_ANCHORED_FLOAT = /(^|[^a-z0-9-])bg-(card|elevated)([^a-z0-9-]|$)/;

/**
 * Names the overlay family a file belongs to, by filename.
 *
 * The families are listed here rather than in the config so the decision
 * is testable: a config that routes by glob is only as correct as the
 * glob, and nothing fails when someone edits it.
 * @param filename Absolute path of the file being linted.
 * @returns The family's forbidden pattern and label, or null if unrelated.
 */
function familyOf(filename: string): {
  readonly forbidden: RegExp;
  readonly family: string;
  readonly expected: string;
} | null {
  const base = filename.replace(/\\/g, "/").split("/").pop() ?? "";
  const component = base.replace(/\.tsx?$/, "");
  if (CONTENT_PANELS.has(component)) {
    return {
      forbidden: NOT_ON_CONTENT_PANEL,
      family: "content panels",
      expected: "bg-card",
    };
  }
  if (ANCHORED_FLOATS.has(component)) {
    return {
      forbidden: NOT_ON_ANCHORED_FLOAT,
      family: "anchored floats",
      expected: "bg-popover",
    };
  }
  return null;
}

/**
 * Overlay panels take the surface their family calls for.
 *
 * Floating overlays split in two. A content panel (dialog, alert dialog,
 * sheet) arrives with a backdrop and holds a body of content, so it takes
 * `bg-card` and matches the cards on the page. An anchored float (popover,
 * menu, picker, toast) hangs off a trigger with the page still visible
 * behind it, so it takes `bg-popover`, which reads as a layer above rather
 * than a replacement for. `bg-elevated` belongs to neither.
 *
 * `bg-background` stays allowed on both — a command dialog's wrapper or a
 * select trigger legitimately sits on the page surface — as do the hover
 * fills inside menu items, which are not panel surfaces.
 *
 * Narrower than the guard in one respect, and correct to be: the guard
 * grepped whole lines, so a doc comment naming `bg-popover` counted as
 * using it. Two such comments exist today; neither is in a file where its
 * family forbids that surface, so this is not a verdict change — but it is
 * the difference between checking what ships and checking what is written.
 */
export const overlaySurface = createRule<[], "wrongSurface">({
  name: "overlay-surface",
  meta: {
    type: "problem",
    docs: {
      description: "Overlay panels use the surface token their family takes",
    },
    schema: [],
    messages: {
      wrongSurface:
        "{{match}} is the wrong surface here — {{family}} take {{expected}}.",
    },
  },
  defaultOptions: [],
  create(context) {
    const matched = familyOf(context.filename);
    if (matched === null) return {};
    const { forbidden, family, expected } = matched;

    /**
     * Reports the node when its class string carries the wrong surface.
     * @param node Node to report on.
     * @param text The class string to test.
     */
    function check(node: TSESTree.Node, text: string): void {
      const hit = forbidden.exec(text);
      if (hit) {
        context.report({
          node,
          messageId: "wrongSurface",
          data: { match: hit[0].trim(), family, expected },
        });
      }
    }

    return {
      Literal: (node: TSESTree.Literal): void => {
        if (typeof node.value === "string") check(node, node.value);
      },
      TemplateElement: (node: TSESTree.TemplateElement): void =>
        check(node, node.value.raw),
    };
  },
});
