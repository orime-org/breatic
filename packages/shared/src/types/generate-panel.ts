// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The two parameter names the panel spells (#261, #269).
 *
 * How a parameter gets filled is the model's to declare, so nothing here says
 * which modes fill what. What is left is the panel's own vocabulary: the two
 * places it reaches by name rather than by walking a registry.
 */

/**
 * The parameter the panel keeps in a text box of its own, beside the prompt.
 *
 * The words to sing are collaborative text like the prompt is, so the node
 * carries them in a second shared fragment and the panel reads that. Nothing
 * written under this name in a node's parameters reaches the box, and the
 * panel refuses to generate a vocal track on an empty one -- so an answer
 * that treats it as an ordinary parameter tells the user something is set
 * when the box in front of them is blank.
 */
export const PANEL_EDITOR_PARAM = "lyrics";
