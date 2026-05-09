/**
 * `features/prompt-editor` — Tiptap-based prompt editor with @-chip
 * inline-atom support, designed to be reused by:
 *
 *   - GenerativeNode (canvas) — bound to Y.XmlFragment for collaboration
 *   - ChatPanel (private chat, F12) — local state only, no Collaboration
 *
 * Public API:
 *   - {@link PromptEditor} — main component
 *   - {@link Chip} — Tiptap atom node (re-exported in case the chat
 *     surface wants to mount it without Collaboration)
 *   - {@link buildMentionSuggestion} — suggestion config builder
 *   - {@link ReferenceSuggestionItem} — picker row shape
 */
export { PromptEditor } from './PromptEditor';
export { Chip } from './ChipNode';
export {
  buildMentionSuggestion,
  type ReferenceSuggestionItem,
} from './use-mention-suggestion';
