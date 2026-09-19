// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

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
 * reference-clip switch is not mounted until a clip is picked, the lyrics box
 * is taken away while the track is marked instrumental, and the four camera
 * wheels are drawn whatever the switch says while the run throws their values
 * out until it is on. Told only that a control exists, a reader who sets one
 * of these three gets nothing for it.
 *
 * One shape for all three because they ask the same of a reader — do this
 * first, or setting it is wasted — and one clause in the answer can say so.
 */
export type ControlGate =
  /** That source parameter has to hold something first. */
  | { readonly kind: "source"; readonly param: string }
  /** That switch has to be on; the value is dropped while it is off. */
  | { readonly kind: "flagOn"; readonly param: string }
  /** That switch has to be off; the control goes away while it is on. */
  | { readonly kind: "flagOff"; readonly param: string };



/**
 * The source parameter a reader fills by naming it in the prompt.
 *
 * Two gestures reach a source and they are not interchangeable. A slot is
 * picked: click the slot, click a node, done. The reference list is two steps
 * — an incoming edge puts an image in the pool, and an `@`-mention in the
 * prompt picks which of the pool this run uses. Told only to point a node at
 * this one, a reader wires an edge, presses Generate, and the run goes out
 * with no source at all.
 */
export const REFERENCE_POOL_PARAM = "images";

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
