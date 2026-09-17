// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Tool names that more than one list has to agree on.
 *
 * Its own file, and importing nothing, so that anything needing one of these
 * can read it rather than write it out again. The registry beside it imports every
 * tool, and every tool imports the `ai` SDK -- which is why the test stub for
 * this package deliberately does not load it, and why a name written out a
 * second time in that stub went unnoticed when it was wrong.
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
export const ASK_USER = "ask_user";

/**
 * Ask which modes each generation node can be set to.
 *
 * Written here for the reason above: the registry key, the plain-chat tool
 * list and the server's render registry all have to name the same tool, and
 * the render registry is the one where a disagreement is silent -- the turn
 * that ran the tool reads the rendered text, and every later turn reads the
 * raw payload as JSON instead.
 */
export const GET_CANVAS_CAPABILITIES = "get_canvas_capabilities";

/** Ask which models back one mode of one generation node. */
export const LIST_GENERATION_MODELS = "list_generation_models";

/** Proposes a wired group of nodes for the reader to place (#229). */
export const PROPOSE_CANVAS_ACTION = "propose_canvas_action";
