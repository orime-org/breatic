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
 * Written here for the reason above: the registry key and `CANVAS_TOOLS`
 * both have to name the same tool.
 */
export const GET_CANVAS_CAPABILITIES = "get_canvas_capabilities";

/** Ask which models back one mode of one generation node. */
export const LIST_GENERATION_MODELS = "list_generation_models";

/**
 * Read how the reader operates our product (#260).
 *
 * Named here because other tools' descriptions point the model at it, and a
 * pointer spelled out a second time can name a tool that is not there.
 */
export const GET_PRODUCT_GUIDE = "get_product_guide";

/** Proposes a wired group of nodes for the reader to place (#229). */
export const PROPOSE_CANVAS_ACTION = "propose_canvas_action";

/**
 * Proposes a comment, a rewrite or an insert for the open document
 * (inner#1509). Named here because the turn's tool context hands this tool
 * the open document under its name.
 */
export const PROPOSE_DOCUMENT_EDIT = "propose_document_edit";

/**
 * Saves a found picture into our storage (inner#1315).
 *
 * Named here because the proposal check points the model at it when an
 * address is not ours yet.
 */
export const SAVE_IMAGE = "save_image";

/**
 * Ask for a judgement over what the model is holding, with the odds (#282).
 *
 * Written here for the reason above: the registry key, the baseline list and
 * the requirements table all have to name the same tool, and a tool missing
 * from the requirements table is one a deployment with no key offers anyway.
 */
export const JUDGE_LIKELIHOOD = "judge_likelihood";
