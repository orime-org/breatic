/**
 * Build a Tiptap suggestion config that wires `@` mention triggers to
 * the prompt editor's reference list.
 *
 * The suggestion plugin tracks the user typing `@xxx`, calls our
 * `items()` to filter references by the query, and on selection
 * inserts a {@link Chip} atom node carrying the frozen
 * {@link ChipSnapshot} attrs (spec §10.13.2 v13 — chips are
 * independent copies, captured at @-time, untouched by later edits to
 * the upstream node).
 *
 * The picker UI is owned by {@link mountSuggestionPicker}; this file
 * is the data + behaviour wiring only.
 */
import type { Editor } from '@tiptap/core';
import type { Range } from '@tiptap/core';
import type { SuggestionOptions } from '@tiptap/suggestion';
import { mountSuggestionPicker } from './SuggestionPicker';

/**
 * One row in the picker / one option that can be selected. F2-prompt
 * derives this list from the GenerativeNode's incoming edges — the
 * Yjs `references` Y.Array (with addedAt + ordering) lands in F3.
 */
export interface ReferenceSuggestionItem {
  /**
   * Stable identifier for this row in the picker. F3 will replace this
   * with the actual `ReferenceItem.refId`; F2-prompt uses the edge id.
   */
  refId: string;
  sourceNodeId: string;
  sourceNodeType: 'image' | 'video' | 'audio' | 'text' | 'generative';
  /** Live name from the upstream node — display only, not frozen. */
  sourceNodeName: string;
  /** Live thumbnail URL when available. */
  thumbnail?: string;
}

interface BuildMentionSuggestionConfig {
  /** Live reference list (re-evaluated each call). Kept inside a ref so the closure picks up updates without rebuilding the whole editor. */
  getReferences: () => ReferenceSuggestionItem[];
}

/**
 * Build the suggestion options object passed into the
 * `@tiptap/extension-mention` (or our extended {@link Chip}) so the
 * `@` trigger uses our picker + ChipSnapshot capture.
 *
 * The return type is widened to {@link SuggestionOptions} with `any`
 * generics because `@tiptap/extension-mention` defaults its options
 * generic to `MentionNodeAttrs`, while the Chip extension carries the
 * full ChipSnapshot attrs instead. The runtime contract matches —
 * Tiptap doesn't validate attrs against the generic — but TypeScript
 * needs the cast to accept the wider attrs shape.
 */
export function buildMentionSuggestion({
  getReferences,
}: BuildMentionSuggestionConfig): Omit<SuggestionOptions, 'editor'> {
  const config = {
    char: '@',
    items: ({ query }: { query: string }): ReferenceSuggestionItem[] => {
      const list = getReferences();
      if (!query) return list;
      const lower = query.toLowerCase();
      return list.filter((r) => r.sourceNodeName.toLowerCase().includes(lower));
    },
    command: ({
      editor,
      range,
      props,
    }: {
      editor: Editor;
      range: Range;
      props: ReferenceSuggestionItem;
    }) => {
      // Insert the chip atom node at the @ trigger range, with a
      // frozen ChipSnapshot of the upstream's current display fields
      // (spec §10.13.2 — name and thumbnail are captured here and
      // never re-read).
      const chipId = crypto.randomUUID();
      editor
        .chain()
        .focus()
        .insertContentAt(range, [
          {
            type: 'chip',
            attrs: {
              chipId,
              sourceNodeId: props.sourceNodeId,
              sourceNodeType: props.sourceNodeType,
              snapshotName: props.sourceNodeName,
              snapshotThumbnail: props.thumbnail ?? null,
              snapshotContent: null,
              capturedAt: Date.now(),
            },
          },
          { type: 'text', text: ' ' },
        ])
        .run();
    },
    render: () => mountSuggestionPicker(),
  };
  return config as Omit<SuggestionOptions, 'editor'>;
}
