// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

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
 * Putting a question to the user is the end of what the current turn can
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

/** The tool that asks the user to let the agent read other Spaces (inner#1552). */
export const REQUEST_SPACE_CONTENT = "request_space_content";

/**
 * The tools a turn stops at to wait for the user: a call with no `execute`
 * whose result comes back in the request that resumes the turn.
 */
export const AWAITS_USER: readonly string[] = [ASK_USER, REQUEST_SPACE_CONTENT];

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
 * Read how the user operates our product (#260).
 *
 * Named here because other tools' descriptions point the model at it, and a
 * pointer spelled out a second time can name a tool that is not there.
 */
export const GET_PRODUCT_GUIDE = "get_product_guide";

/**
 * Read one generation template in full (inner#1807).
 *
 * Named here because the proposal tool's description points the model at it.
 */
export const GET_GENERATION_TEMPLATE = "get_generation_template";

/** Proposes a wired group of nodes for the user to place (#229). */
export const PROPOSE_CANVAS_ACTION = "propose_canvas_action";

/**
 * Proposes a comment, a rewrite or an insert for the open document
 * (inner#1509). Named here because the turn's tool context hands this tool
 * the open document under its name.
 */
export const PROPOSE_DOCUMENT_EDIT = "propose_document_edit";

/**
 * Proposes a 3D generation the user opens in a 3D Space (inner#1691). Named
 * here because the turn's tool context hands this tool the project under its
 * name.
 */
export const PROPOSE_SCENE_GENERATION = "propose_scene_generation";

/**
 * Saves a found picture into our storage (inner#1315).
 *
 * Named here because the proposal check points the model at it when an
 * address is not ours yet.
 */
export const SAVE_IMAGE = "save_image";

/** Understands one ordered batch of images, video or audio. */
export const UNDERSTAND_MEDIA = "understand_media";

/**
 * Ask for a judgement over what the model is holding, with the odds (#282).
 *
 * Written here for the reason above: the registry key, the baseline list and
 * the requirements table all have to name the same tool, and a tool missing
 * from the requirements table is one a deployment with no key offers anyway.
 */
export const JUDGE_LIKELIHOOD = "judge_likelihood";

// The four tools that read the user's records (inner#1469). Named here
// because the turn's tool context hands each of them the turn's records under
// its name, and their descriptions point at one another.

/** List or search the user's conversations in this project. */
export const SEARCH_CONVERSATIONS = "search_conversations";

/** Read whole turns of one of the user's conversations. */
export const READ_CONVERSATION = "read_conversation";

/** Read a canvas node's tasks and versions. */
export const READ_NODE_HISTORY = "read_node_history";

/** Read the project's activity feed. */
export const LIST_PROJECT_ACTIVITY = "list_project_activity";

/** The four record tools' names, the one list every place that treats them alike reads. */
export const RECORD_TOOL_NAMES = [SEARCH_CONVERSATIONS, READ_CONVERSATION, READ_NODE_HISTORY, LIST_PROJECT_ACTIVITY] as const;

// The three tools the Agent keeps its own memory with (#1363). Named here
// because the system prompt's memory protocol says when to use each, and the
// registry key has to be the same name.

/** Add a memory entry, or replace one. */
export const SAVE_MEMORY = "save_memory";

/** Delete a memory entry. */
export const DELETE_MEMORY = "delete_memory";

/** Read memory entries in full, by id or by words. */
export const READ_MEMORY = "read_memory";

/** The three memory tools' names. */
export const MEMORY_TOOL_NAMES = [SAVE_MEMORY, DELETE_MEMORY, READ_MEMORY] as const;
