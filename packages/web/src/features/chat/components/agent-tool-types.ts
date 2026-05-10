/**
 * Agent rich-output tool types — typed shape for the three v13
 * interaction tools the agent can emit inline in a chat message
 * (spec/02 §10.18.4):
 *
 *   - `ask_user_choice` — multiple-choice picker; one selection per
 *     message, disables the rest after the user picks.
 *   - `show_search_results` — thumbnail grid; hover-revealed button
 *     to add a result to the current Space.
 *   - `propose_canvas_action` — apply-once button that creates one
 *     or more nodes on the canvas (today only `create_nodes`).
 *
 * Aligns with the backend's `interaction_tool_call` shape produced
 * by the chat / agent stream (B4). Where possible, fields use
 * permissive optional shapes so a backend that adds new attributes
 * doesn't break the frontend renderer.
 */

import type { ChatChipKind } from './ChatComposer';

export type AgentToolName =
  | 'ask_user_choice'
  | 'show_search_results'
  | 'propose_canvas_action';

/** One option in an `ask_user_choice` tool call. */
export interface AgentChoiceOption {
  id: string;
  label: string;
  /** Optional secondary line shown under the label (e.g. trade-off text). */
  description?: string;
}

export interface AgentToolArgsAskUserChoice {
  question: string;
  choices: AgentChoiceOption[];
}

/** One image hit in a `show_search_results` tool call. */
export interface AgentSearchHit {
  /** Image URL — empty / `'#'` is treated as "use placeholder" by the renderer. */
  url: string;
  title: string;
  /** Provenance label shown in the thumbnail overlay. */
  source: string;
}

export interface AgentToolArgsShowSearchResults {
  images: AgentSearchHit[];
}

/** One node the agent proposes to add. */
export interface AgentProposedNode {
  type: ChatChipKind;
  label: string;
}

export interface AgentToolArgsProposeCanvasAction {
  /** Today only `'create_nodes'`; reserved for future verbs (`update_nodes` etc). */
  action: string;
  /** Why the agent is proposing this — surfaced above the node list as context. */
  rationale: string;
  nodes: AgentProposedNode[];
}

/**
 * Discriminated union of the three tool calls. Useful for the
 * dispatcher / message store; individual renderers narrow this
 * via the `name` discriminator.
 */
export type AgentToolCall =
  | { name: 'ask_user_choice'; args: AgentToolArgsAskUserChoice }
  | { name: 'show_search_results'; args: AgentToolArgsShowSearchResults }
  | { name: 'propose_canvas_action'; args: AgentToolArgsProposeCanvasAction };
