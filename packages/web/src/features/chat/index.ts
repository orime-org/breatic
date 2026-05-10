/**
 * Chat feature — v13 left-rail chat panel + supporting hooks.
 *
 * Composes the v13 chat experience: `ChatPanel` (B.1) talks to
 * `chatApi.sendMessage` SSE; `useChatStream` consumes the events;
 * `ChatComposer` (F12) is the bordered input shell with chips row +
 * Send; `AgentToolMessage` (F13) routes the agent's interaction
 * tool calls to the right widget (`AgentChoicePicker` /
 * `AgentSearchResultsGrid` / `AgentCanvasActionButton`).
 *
 * The v12 contenteditable composer + per-node `NodeChatComposer` +
 * `AgentInput` / `AgentComposerTabs` / `AgentSendButton` /
 * `AgentAtPanel` / `RecognizedPickDropdown` /
 * `AiChatRecordPanel` files were deleted in B.2 — they were all
 * dead after B.1 swapped `ChatPanel` in at the page-level mount
 * point, and their canvas-pick-into-editor flow was fully
 * replaced by `ChipsPickContext`.
 */

export { default as ChatPanel } from './components/ChatPanel';
export { default as ChatComposer } from './components/ChatComposer';
export { default as AgentMessage } from './components/AgentMessage';
export { default as AgentChoicePicker } from './components/AgentChoicePicker';
export { default as AgentSearchResultsGrid } from './components/AgentSearchResultsGrid';
export { default as AgentCanvasActionButton } from './components/AgentCanvasActionButton';
export { default as AgentToolMessage } from './components/AgentToolMessage';
export { default as EmptyChatRecordState } from './components/EmptyChatRecordState';

export { ChipsPickProvider, useChipsPick } from './contexts/ChipsPickContext';
export { useChatStream } from './use-chat-stream';

export type { ChatStreamMessage } from './use-chat-stream';
export type { ChatChip, ChatChipKind } from './components/ChatComposer';
export type {
  AgentToolName,
  AgentToolCall,
  AgentChoiceOption,
  AgentSearchHit,
  AgentProposedNode,
  AgentToolArgsAskUserChoice,
  AgentToolArgsShowSearchResults,
  AgentToolArgsProposeCanvasAction,
} from './components/agent-tool-types';
