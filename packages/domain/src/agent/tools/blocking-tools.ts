// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * The names of the interaction tools a turn cannot carry on past.
 *
 * Its own file, and importing nothing, so that anything needing these names
 * can read them rather than write them out again. The registry beside it
 * imports every tool, and every tool imports the `ai` SDK -- which is why the
 * test stub for this package deliberately does not load it, and why the names
 * written out a second time in that stub went unnoticed when one of them was
 * wrong.
 */

/**
 * Ask the user something and wait.
 *
 * These two put a question to the reader, and the answer opens the next turn
 * -- so the question is the end of what the current turn can do. The other two
 * interaction tools put something on screen and the model is meant to keep
 * writing around them; stopping on those would make the first card a turn
 * draws the last thing it says.
 */
export const TOOLS_THAT_BLOCK: readonly string[] = ["ask_user_question", "ask_user_choice"];
