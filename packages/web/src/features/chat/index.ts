/**
 * Chat feature — AI conversation panel + composer.
 *
 * Composes the left-panel AI chat experience: the record panel
 * (`AiChatRecordPanel`), the per-node composer (`NodeChatComposer`),
 * and the lower-level inputs / messages / model selector. Shipped
 * as a single feature module so future Agent / chat capabilities
 * (memory inspection, message editing, branching) land here without
 * a second refactor.
 *
 * The legacy `apps/project/components/agent/ProjectHeader.tsx` is
 * NOT part of this feature — it's the project-page header bar (title
 * + share + theme picker). PR-E will lift it into a proper
 * full-width TopBar and remove the redundancy with the temporary
 * `MembersPopover` / `CreditsPill` overlay added in PR4-A.
 */

export { default as AiChatRecordPanel } from './components/AiChatRecordPanel';
export { default as NodeChatComposer } from './components/NodeChatComposer';
export { default as EmptyChatRecordState } from './components/EmptyChatRecordState';
export { default as ChatComposer } from './components/ChatComposer';
export type { ChatChip, ChatChipKind } from './components/ChatComposer';
export { default as AgentChoicePicker } from './components/AgentChoicePicker';
export { default as AgentSearchResultsGrid } from './components/AgentSearchResultsGrid';
export { default as AgentCanvasActionButton } from './components/AgentCanvasActionButton';
export { default as AgentToolMessage } from './components/AgentToolMessage';
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

// Lower-level building blocks. Most callers should import the
// panel / composer above; these are exposed for the rare deep
// composition site (e.g. an embed of the agent input outside the
// project page).
export { default as Agent } from './components/Agent';
export { default as AgentInput } from './components/AgentInput';
export { default as AgentMessage } from './components/AgentMessage';
export { default as AgentAtPanel } from './components/AgentAtPanel';
export { default as AgentComposerTabs } from './components/AgentComposerTabs';
export { default as AgentModelSelect } from './components/AgentModelSelect';
export { default as AgentResourcePreview } from './components/AgentResourcePreview';
export { default as AgentSendButton } from './components/AgentSendButton';
export { default as RecognizedPickDropdown } from './components/RecognizedPickDropdown';
