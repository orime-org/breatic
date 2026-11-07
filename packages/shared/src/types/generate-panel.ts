// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The two parameter names the panel spells, and the shape of a control's
 * condition (#261, #269).
 *
 * How a parameter gets filled is the model's to declare, so nothing here says
 * which modes fill what. What is left is the panel's own vocabulary: the two
 * places it reaches by name rather than by walking a registry, and the shape
 * a declared condition takes once the projection has read it.
 */

/**
 * What has to hold before one of these controls counts for anything.
 *
 * A panel offering a control is not the same as that control being live: the
 * four camera wheels are drawn whatever the switch says while the run throws
 * their values out until it is on. Told only that a control exists, a reader
 * who sets one gets nothing for it.
 */
export type ControlGate =
  /**
   * That switch has to be on, and each param in `equals` has to hold its
   * value; the value is dropped otherwise.
   */
  | {
      readonly kind: "flagOn";
      readonly param: string;
      readonly equals?: Readonly<Record<string, string | number | boolean>>;
    }
  /** Each param has to hold its value (inner#1691). */
  | { readonly kind: "equals"; readonly equals: Readonly<Record<string, string | number | boolean>> };

/**
 * The parameter the panel keeps in a text box of its own, beside the prompt.
 *
 * The words to sing are collaborative text like the prompt is, so the node
 * carries them in a second shared fragment and the panel reads that. Nothing
 * written under this name in a node's parameters reaches the box, and the
 * panel refuses to generate a vocal track on an empty one -- so an answer
 * that treats it as an ordinary parameter tells the reader something is set
 * when the box in front of them is blank.
 */
export const PANEL_EDITOR_PARAM = "lyrics";
