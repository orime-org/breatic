/**
 * ChipNode — Tiptap atom node carrying a frozen reference snapshot
 * (spec §10.13.1 / §10.13.2 v13).
 *
 * A chip is a single inline node that:
 *   - is atomic (cursor skips over, Backspace deletes whole)
 *   - serializes its `ChipSnapshot` attrs into the ProseMirror doc, so
 *     the snapshot survives renames / deletions of the upstream node
 *     (the "C1 independent copy" semantic, spec §6.2)
 *   - renders as `@${snapshotName}` text in HTML, with a `data-chip-id`
 *     marker so future polish (F12) can swap to a richer pill widget
 *
 * Built by extending `@tiptap/extension-mention` because mention is
 * already configured as `atom: true, inline: true, group: 'inline'` —
 * exactly the chip semantics. We rename the node `chip` and add the
 * `ChipSnapshot` fields as `addAttributes()`.
 */
import Mention from '@tiptap/extension-mention';
import { mergeAttributes } from '@tiptap/core';

/**
 * Default snapshot attrs. Used by `addAttributes()` defaults — any
 * chip without an explicit value falls back to these placeholders.
 */
const EMPTY_CHIP_DEFAULTS = {
  chipId: null as string | null,
  sourceNodeId: null as string | null,
  sourceNodeType: null as string | null,
  snapshotName: '',
  snapshotThumbnail: null as string | null,
  snapshotContent: null as string | null,
  capturedAt: 0,
} as const;

export const Chip = Mention.extend({
  name: 'chip',

  addAttributes() {
    return {
      chipId: {
        default: EMPTY_CHIP_DEFAULTS.chipId,
        parseHTML: (el) => (el as HTMLElement).getAttribute('data-chip-id'),
        renderHTML: (attrs) => ({ 'data-chip-id': attrs.chipId }),
      },
      sourceNodeId: {
        default: EMPTY_CHIP_DEFAULTS.sourceNodeId,
        parseHTML: (el) => (el as HTMLElement).getAttribute('data-source-node-id'),
        renderHTML: (attrs) => ({ 'data-source-node-id': attrs.sourceNodeId }),
      },
      sourceNodeType: {
        default: EMPTY_CHIP_DEFAULTS.sourceNodeType,
        parseHTML: (el) => (el as HTMLElement).getAttribute('data-source-node-type'),
        renderHTML: (attrs) => ({ 'data-source-node-type': attrs.sourceNodeType }),
      },
      snapshotName: {
        default: EMPTY_CHIP_DEFAULTS.snapshotName,
        parseHTML: (el) => (el as HTMLElement).getAttribute('data-snapshot-name') ?? '',
        renderHTML: (attrs) => ({ 'data-snapshot-name': attrs.snapshotName }),
      },
      snapshotThumbnail: {
        default: EMPTY_CHIP_DEFAULTS.snapshotThumbnail,
        parseHTML: (el) => (el as HTMLElement).getAttribute('data-snapshot-thumbnail'),
        renderHTML: (attrs) => ({ 'data-snapshot-thumbnail': attrs.snapshotThumbnail }),
      },
      snapshotContent: {
        default: EMPTY_CHIP_DEFAULTS.snapshotContent,
        parseHTML: (el) => (el as HTMLElement).getAttribute('data-snapshot-content'),
        renderHTML: (attrs) => ({ 'data-snapshot-content': attrs.snapshotContent }),
      },
      capturedAt: {
        default: EMPTY_CHIP_DEFAULTS.capturedAt,
        parseHTML: (el) => Number((el as HTMLElement).getAttribute('data-captured-at') ?? 0),
        renderHTML: (attrs) => ({ 'data-captured-at': String(attrs.capturedAt) }),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'span[data-chip-id]' }];
  },

  renderHTML({ node, HTMLAttributes }) {
    return [
      'span',
      mergeAttributes({ class: 'prompt-chip' }, HTMLAttributes),
      `@${(node.attrs as { snapshotName: string }).snapshotName}`,
    ];
  },

  /**
   * Plain-text fallback used when the editor serializes to text (e.g.
   * for clipboard, or for backend prompt extraction). The user sees
   * `@name` in copied text, just like the mockup textarea did.
   */
  renderText({ node }) {
    return `@${(node.attrs as { snapshotName: string }).snapshotName}`;
  },
});
