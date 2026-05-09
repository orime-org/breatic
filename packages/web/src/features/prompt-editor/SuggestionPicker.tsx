/**
 * SuggestionPicker — minimal floating popover that lists matching
 * references and lets the user click one to insert a chip into the
 * prompt editor (spec §10.13.1 / §10.13.3 v13).
 *
 * Mounted by the `@tiptap/suggestion` plugin via the render() lifecycle
 * — Tiptap calls `onStart` when the user types `@`, `onUpdate` as the
 * query changes, and `onExit` when the trigger ends. We translate those
 * into a portal-rendered React component anchored with floating-ui.
 *
 * Keyboard navigation (↑↓ + Enter) is intentionally **out of scope for
 * F2-prompt**; F12 (ChatPanel) will land it once the same picker is
 * shared between generative-node and chat. For now the picker accepts
 * mouse clicks only — sufficient for the spec's "select from
 * references" interaction, just slower than the eventual polish.
 */
import { computePosition, autoUpdate, flip, offset, shift } from '@floating-ui/dom';
import type { ReferenceSuggestionItem } from './use-mention-suggestion';

/**
 * Tiptap suggestion render() returns these four lifecycle callbacks.
 * The shape matches `@tiptap/suggestion` SuggestionRenderer<Item>.
 */
export interface PickerHandlers<Item> {
  onStart: (props: PickerStartProps<Item>) => void;
  onUpdate: (props: PickerStartProps<Item>) => void;
  onKeyDown: (props: { event: KeyboardEvent }) => boolean;
  onExit: () => void;
}

export interface PickerStartProps<Item> {
  /** Items to render — Tiptap calls `items()` from suggestion config. */
  items: Item[];
  /**
   * Anchor rect for the picker. Built by Tiptap from the document
   * coordinate of the trigger char (`@`). May be null when the
   * editor doesn't expose one (rare, defensive).
   */
  clientRect?: (() => DOMRect | null) | null;
  /**
   * Called when the user picks an item. Triggers the suggestion
   * `command(props)` we configure in use-mention-suggestion.
   */
  command: (item: Item) => void;
}

/**
 * Build a fresh picker instance for one `@` trigger lifecycle.
 *
 * The picker DOM is created in `onStart` and torn down in `onExit`.
 * Tiptap calls `onUpdate` after each keystroke to refresh the items
 * (filtered by the typed query in suggestion's `items()` callback).
 */
export function mountSuggestionPicker(): PickerHandlers<ReferenceSuggestionItem> {
  let rootEl: HTMLDivElement | null = null;
  let cleanupPosition: (() => void) | null = null;
  let currentItems: ReferenceSuggestionItem[] = [];
  let currentCommand: ((item: ReferenceSuggestionItem) => void) | null = null;

  const renderItems = () => {
    if (!rootEl) return;
    rootEl.innerHTML = '';
    if (currentItems.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'prompt-suggestion-empty';
      empty.textContent = 'No matching references';
      rootEl.appendChild(empty);
      return;
    }
    for (const item of currentItems) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'prompt-suggestion-item';
      btn.dataset.refId = item.refId;

      if (item.thumbnail && /^(https?:|data:)/i.test(item.thumbnail)) {
        const img = document.createElement('img');
        img.src = item.thumbnail;
        img.alt = '';
        img.className = 'prompt-suggestion-thumb';
        btn.appendChild(img);
      } else {
        const dot = document.createElement('span');
        dot.className = 'prompt-suggestion-thumb-fallback';
        dot.textContent = '•';
        btn.appendChild(dot);
      }

      const label = document.createElement('span');
      label.className = 'prompt-suggestion-label';
      label.textContent = item.sourceNodeName;
      btn.appendChild(label);

      btn.addEventListener('mousedown', (e) => {
        // mousedown (not click) so the editor doesn't lose focus and
        // Tiptap suggestion lifecycle exits cleanly with the inserted chip.
        e.preventDefault();
        currentCommand?.(item);
      });
      rootEl.appendChild(btn);
    }
  };

  const positionPicker = (clientRect: () => DOMRect | null) => {
    if (!rootEl) return;
    // Build a virtual reference element whose rect tracks the trigger
    // char in the editor. floating-ui auto-updates as the editor scrolls
    // or the layout changes.
    const virtualRef = {
      getBoundingClientRect: () => clientRect() ?? new DOMRect(0, 0, 0, 0),
    };
    cleanupPosition?.();
    cleanupPosition = autoUpdate(virtualRef, rootEl, async () => {
      if (!rootEl) return;
      const { x, y } = await computePosition(virtualRef, rootEl, {
        placement: 'bottom-start',
        middleware: [offset(4), flip(), shift({ padding: 4 })],
      });
      rootEl.style.left = `${x}px`;
      rootEl.style.top = `${y}px`;
    });
  };

  return {
    onStart: ({ items, command, clientRect }) => {
      currentItems = items;
      currentCommand = command;
      rootEl = document.createElement('div');
      rootEl.className = 'prompt-suggestion-popover';
      rootEl.style.position = 'absolute';
      rootEl.style.zIndex = '9999';
      document.body.appendChild(rootEl);
      renderItems();
      if (clientRect) positionPicker(clientRect);
    },
    onUpdate: ({ items, command, clientRect }) => {
      currentItems = items;
      currentCommand = command;
      renderItems();
      if (clientRect) positionPicker(clientRect);
    },
    onKeyDown: ({ event }) => {
      // F2-prompt: only Escape closes the picker. ↑↓ + Enter land in F12.
      if (event.key === 'Escape') {
        cleanupPosition?.();
        cleanupPosition = null;
        rootEl?.remove();
        rootEl = null;
        return true;
      }
      return false;
    },
    onExit: () => {
      cleanupPosition?.();
      cleanupPosition = null;
      rootEl?.remove();
      rootEl = null;
      currentItems = [];
      currentCommand = null;
    },
  };
}
