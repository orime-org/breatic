// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

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
 * Putting a question to the reader is the end of what the current turn can
 * do: the answer opens the next one. The other interaction tools put
 * something on screen and the model is meant to keep writing around them;
 * stopping on those would make the first card a turn draws the last thing it
 * says.
 *
 * The name is written once, here, and every list that needs it reads it from
 * here -- including the registry key the tool answers to. Written out a second
 * time, a disagreement throws nothing: the match simply never happens, and a
 * turn carries on talking past the question it just asked.
 */
// eslint-disable-next-line jsdoc/require-jsdoc -- the block above documents it
export const ASK_USER = "ask_user";

export const TOOLS_THAT_BLOCK: readonly string[] = [ASK_USER];
