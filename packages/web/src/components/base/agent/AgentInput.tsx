import React, { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { autoUpdate, flip, offset, shift, useDismiss, useFloating, FloatingPortal } from '@floating-ui/react';
import { cn } from '@/utils/classnames';
import AgentAtPanel, { type AgentAtPanelSourceItem } from './AgentAtPanel';
import type { AgentComposerUpstreamItem, AgentComposerUploadItem } from './AgentComposerTabs';
import { type AgentResourceType } from './AgentResourcePreview';

export type { AgentResourceType } from './AgentResourcePreview';

const canvasPickCaretRangeByPlaceholderId = new Map<string, Range>();

export const captureCanvasPickCaretRange = (placeholderId: string, sourceId: string): void => {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return;
  const host = document.querySelector(`[data-agent-canvas-pick-source-id="${sourceId}"]`) as HTMLElement | null;
  if (!host) return;
  try {
    const range = sel.getRangeAt(0);
    if (!host.contains(range.commonAncestorContainer)) return;
    canvasPickCaretRangeByPlaceholderId.set(placeholderId, range.cloneRange());
  } catch {
    // ignore stale selection
  }
};

const consumeCanvasPickCaretRange = (placeholderId: string): Range | null => {
  const range = canvasPickCaretRangeByPlaceholderId.get(placeholderId) ?? null;
  canvasPickCaretRangeByPlaceholderId.delete(placeholderId);
  if (!range) return null;
  try {
    return range.cloneRange();
  } catch {
    return null;
  }
};

export type AgentCanvasPickSurfaceRemovalDetail = {
  placeholderId: string;
  surface: 'recognizing' | 'chip';
};

export interface AgentComposerInputHandle {
  addImageFromUrl: (url: string) => void;
  addResourceFromUrl: (url: string, name: string, type: AgentResourceType) => void;
  /** Focus the editor and ensure a caret exists inside it. */
  focusEditor: () => void;
  clear: () => void;
  getHtml: () => string;
  isEmpty: () => boolean;
  openMentionPanel: () => void;
  /** Returns true when the recognizing pill was actually inserted into the editor. */
  appendCanvasPickRecognizingPlaceholder: (placeholderId: string) => boolean;
  removeCanvasPickPlaceholder: (placeholderId: string) => void;
  replaceCanvasPickPlaceholderWithImageChip: (
    placeholderId: string,
    url: string,
    name: string,
    type?: AgentResourceType,
  ) => void;
  replaceCanvasPickChipById: (placeholderId: string, url: string, name: string, type?: AgentResourceType) => void;
  setHtml: (html: string) => void;
}

type AgentComposerInputProps = {
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  onEnterSend?: () => void;
  onEmptyChange?: (empty: boolean) => void;
  onFocusChange?: (focused: boolean) => void;
  canvasPickSourceId?: string;
  upstreamItems?: AgentComposerUpstreamItem[];
  uploadItems?: AgentComposerUploadItem[];
  onHtmlChange?: (html: string) => void;
  /** When the user deletes a canvas-pick “recognizing” pill or the resulting image chip, sync node overlays. */
  onCanvasPickSurfaceRemoved?: (detail: AgentCanvasPickSurfaceRemovalDetail) => void;
};

const defaultRect = (): DOMRect => new DOMRect(0, 0, 0, 0);

const defaultLabelByResourceType: Record<AgentResourceType, string> = {
  image: 'Image',
  video: 'Video',
  audio: 'Audio',
  text: 'Text',
  file: 'File',
};

type FloatingRefs = {
  setFloating: (node: HTMLElement | null) => void;
};

type AgentFloatingPopoverProps = {
  open: boolean;
  refs: FloatingRefs;
  floatingStyles: React.CSSProperties;
  className?: string;
  children?: React.ReactNode;
  divProps?: React.ComponentPropsWithoutRef<'div'>;
};

const AgentFloatingPopover: React.FC<AgentFloatingPopoverProps> = ({
  open,
  refs,
  floatingStyles,
  className,
  children,
  divProps,
}) => {
  if (!open) return null;

  return (
    <FloatingPortal>
      <div ref={refs.setFloating} style={floatingStyles} className={cn('relative', className)} {...divProps}>
        {children}
      </div>
    </FloatingPortal>
  );
};

const canvasPickPlaceholderAttr = 'data-canvas-pick-placeholder';
const canvasPickChipIdAttr = 'data-agent-canvas-pick-id';

const resourceChipWrapperClass = 'inline-flex items-center gap-1 align-middle max-w-[126px] py-0.5 px-2 mx-0.5 rounded-full border border-[var(--color-border-default-base)] min-w-0 cursor-pointer';
const resourceChipImgClass = 'w-[16px] h-[16px] object-cover rounded-[4px] shrink-0';
const resourceChipLabelClass = 'min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-xs';
const iconBoxClass = 'w-[16px] h-[16px] rounded-[4px] shrink-0 inline-flex items-center justify-center bg-[var(--color-background-default-secondary)]';
const docIconInnerHTML = '<svg width="14" height="14" class="text-white" fill="currentColor"><use href="#icon-project-chat_doc_icon"></use></svg>';
const textDocIconInnerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 10 10" class="text-[var(--bg-icon-base)]" fill="currentColor"><path d="M3.66667 1.875H1C0.722222 1.875 0.486111 1.78385 0.291667 1.60156C0.0972222 1.41927 0 1.19792 0 0.9375C0 0.677083 0.0972222 0.455729 0.291667 0.273438C0.486111 0.0911458 0.722222 0 1 0H8.33333C8.61111 0 8.84722 0.0911458 9.04167 0.273438C9.23611 0.455729 9.33333 0.677083 9.33333 0.9375C9.33333 1.19792 9.23611 1.41927 9.04167 1.60156C8.84722 1.78385 8.61111 1.875 8.33333 1.875H5.66667V9.0625C5.66667 9.32292 5.56944 9.54427 5.375 9.72656C5.18056 9.90885 4.94444 10 4.66667 10C4.38889 10 4.15278 9.90885 3.95833 9.72656C3.76389 9.54427 3.66667 9.32292 3.66667 9.0625V1.875Z" fill="currentColor"/></svg>';
const audioIconInnerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="12" viewBox="0 0 8 12" class="text-[var(--bg-icon-base)]" fill="currentColor"><path d="M2.66667 12C1.93333 12 1.30556 11.7389 0.783333 11.2167C0.261111 10.6944 0 10.0667 0 9.33333C0 8.6 0.261111 7.97222 0.783333 7.45C1.30556 6.92778 1.93333 6.66667 2.66667 6.66667C2.92222 6.66667 3.15833 6.69722 3.375 6.75833C3.59167 6.81944 3.8 6.91111 4 7.03333V0.666667C4 0.477778 4.06389 0.319444 4.19167 0.191667C4.31944 0.0638889 4.47778 0 4.66667 0H7.33333C7.52222 0 7.68056 0.0638889 7.80833 0.191667C7.93611 0.319444 8 0.477778 8 0.666667V2C8 2.18889 7.93611 2.34722 7.80833 2.475C7.68056 2.60278 7.52222 2.66667 7.33333 2.66667H5.33333V9.33333C5.33333 10.0667 5.07222 10.6944 4.55 11.2167C4.02778 11.7389 3.4 12 2.66667 12Z" fill="currentColor"/></svg>';

const createChip = (url: string, name: string, type: AgentResourceType): HTMLSpanElement => {
  const wrapper = document.createElement('span');
  wrapper.contentEditable = 'false';
  wrapper.setAttribute('data-resource', url);
  wrapper.setAttribute('data-resource-type', type);
  wrapper.className = resourceChipWrapperClass;

  const iconBox = document.createElement('span');
  iconBox.className = iconBoxClass;
  iconBox.setAttribute('aria-hidden', 'true');

  // Image/video chips use media previews; other types use icons (no status dot).
  if (type === 'image') {
    const img = document.createElement('img');
    img.src = url;
    img.alt = name;
    img.className = resourceChipImgClass;
    wrapper.appendChild(img);
  } else if (type === 'video') {
    const thumbWrap = document.createElement('span');
    thumbWrap.className =
      'relative w-[14px] h-[14px] rounded-[2px] shrink-0 overflow-hidden bg-[var(--color-background-default-secondary)]';

    const img = document.createElement('img');
    img.alt = name;
    img.className = 'w-full h-full object-cover';
    img.setAttribute('aria-hidden', 'true');
    thumbWrap.appendChild(img);

    const playOverlay = document.createElement('span');
    playOverlay.className =
      'absolute inset-0 flex items-center justify-center bg-black/20 rounded-[2px] pointer-events-none';
    playOverlay.innerHTML =
      '<svg width="6" height="6" class="text-white drop-shadow" fill="currentColor"><use href="#icon-project-play_audio_icon"></use></svg>';
    thumbWrap.appendChild(playOverlay);

    wrapper.appendChild(thumbWrap);

    // Decode first frame for cover; needs preload='auto'; may fail cross-origin.
    try {
      const v = document.createElement('video');
      v.muted = true;
      v.playsInline = true;
      v.preload = 'auto';
      const cleanup = () => {
        v.removeAttribute('src');
        v.load?.();
      };
      const capture = () => {
        try {
          const w = v.videoWidth || 0;
          const h = v.videoHeight || 0;
          if (!w || !h) {
            cleanup();
            return;
          }
          const canvas = document.createElement('canvas');
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext('2d');
          if (!ctx) {
            cleanup();
            return;
          }
          ctx.drawImage(v, 0, 0, w, h);
          canvas.toBlob(
            (blob) => {
              if (blob) img.src = URL.createObjectURL(blob);
              cleanup();
            },
            'image/jpeg',
            0.7,
          );
        } catch {
          cleanup();
        }
      };
      v.addEventListener('canplay', capture, { once: true });
      v.addEventListener('error', cleanup, { once: true });
      v.src = url;
    } catch {
      // ignore
    }
  } else {
    if (type === 'text') iconBox.innerHTML = textDocIconInnerHTML;
    else if (type === 'audio') iconBox.innerHTML = audioIconInnerHTML;
    else iconBox.innerHTML = docIconInnerHTML;
    wrapper.appendChild(iconBox);
  }

  const labelSpan = document.createElement('span');
  labelSpan.className = resourceChipLabelClass;
  labelSpan.textContent = name;
  wrapper.appendChild(labelSpan);

  return wrapper;
};

const AgentComposerInput = forwardRef<AgentComposerInputHandle, AgentComposerInputProps>(
  (
    {
      placeholder = 'Use "/" to activate skills.\nUse "@" to add resources to the dialogue.',
      disabled = false,
      className,
      onEnterSend,
      onEmptyChange,
      onFocusChange,
      canvasPickSourceId,
      upstreamItems = [],
      uploadItems = [],
      onHtmlChange,
      onCanvasPickSurfaceRemoved,
    },
    ref,
  ) => {
    const editableRef = useRef<HTMLDivElement>(null);
    /** Last selection inside the editor; canvas pick inserts the placeholder here. */
    const canvasPickCaretRangeRef = useRef<Range | null>(null);
    const prevCanvasPickPlaceholdersRef = useRef<Set<string>>(new Set());
    const prevCanvasPickChipsRef = useRef<Set<string>>(new Set());
    const [empty, setEmpty] = useState(true);
    const placeholderLines = placeholder.split('\n');
    const [showAtPanel, setShowAtPanel] = useState(false);
    const atAnchorElRef = useRef<HTMLElement | null>(null);
    const virtualElRef = useRef({
      getBoundingClientRect: (): DOMRect => {
        const anchor = atAnchorElRef.current;
        if (anchor) return anchor.getBoundingClientRect();
        const spans = editableRef.current?.querySelectorAll?.('span[data-chat-at="true"]');
        const last = spans?.length ? spans[spans.length - 1] : null;
        return (last as HTMLElement)?.getBoundingClientRect?.() ?? defaultRect();
      },
    } as { getBoundingClientRect: () => DOMRect });

    const {
      refs: atRefs,
      floatingStyles: atFloatingStyles,
      context: atContext,
    } = useFloating({
      open: showAtPanel,
      onOpenChange: setShowAtPanel,
      placement: 'top-start',
      whileElementsMounted: autoUpdate,
      middleware: [offset(8), flip({ padding: 8 }), shift({ padding: 8 })],
    });

    useDismiss(atContext);
    const hasAtPanelContent = upstreamItems.length > 0 || uploadItems.length > 0;

    const openAtPanel = () => {
      if (!hasAtPanelContent) return;
      setShowAtPanel(true);
      atRefs.setReference(virtualElRef.current);
    };

    const closeAtPanel = () => {
      setShowAtPanel(false);
      atRefs.setReference(null);
    };

    /** Tracks selection while focused so canvas-pick uses the last caret before blur. */
    useEffect(() => {
      const onSelectionChange = () => {
        const ed = editableRef.current;
        if (!ed || document.activeElement !== ed) return;
        const sel = window.getSelection();
        if (!sel || sel.rangeCount === 0) return;
        try {
          const range = sel.getRangeAt(0);
          if (ed.contains(range.commonAncestorContainer)) {
            canvasPickCaretRangeRef.current = range.cloneRange();
          }
        } catch {
          // Stale range after DOM churn
        }
      };
      document.addEventListener('selectionchange', onSelectionChange);
      return () => document.removeEventListener('selectionchange', onSelectionChange);
    }, []);

    const updateEmpty = () => {
      const text = editableRef.current?.innerText?.replace(/\u00A0/g, ' ').trim() ?? '';
      const next = text.length === 0;
      setEmpty(next);
      onEmptyChange?.(next);
    };

    const scrollEditableToBottom = () => {
      const el = editableRef.current;
      if (!el) return;
      const selection = window.getSelection();

      const ensureCaretVisible = () => {
        if (!selection || selection.rangeCount === 0) return;
        const range = selection.getRangeAt(0);
        if (!el.contains(range.commonAncestorContainer)) return;
        const caretRange = range.cloneRange();
        caretRange.collapse(false);
        const caretRect = caretRange.getBoundingClientRect();
        const elRect = el.getBoundingClientRect();
        if (!caretRect.width && !caretRect.height) return;

        const overBottom = caretRect.bottom - elRect.bottom;
        if (overBottom > 0) {
          el.scrollTop += overBottom + 8;
        }
      };

      requestAnimationFrame(() => {
        el.scrollTop = el.scrollHeight;
        ensureCaretVisible();
        requestAnimationFrame(() => {
          el.scrollTop = el.scrollHeight;
          ensureCaretVisible();
        });
      });
    };

    /** Wraps the `@` before the caret in a span and moves the caret after it. */
    const wrapAtBeforeCaretInSpan = (): HTMLElement | null => {
      const el = editableRef.current;
      if (!el) return null;
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return null;
      const range = sel.getRangeAt(0);
      if (!el.contains(range.commonAncestorContainer)) return null;

      const makeAtSpan = () => {
        const atSpan = document.createElement('span');
        atSpan.setAttribute('data-chat-at', 'true');
        atSpan.appendChild(document.createTextNode('@'));
        return atSpan;
      };

      // Case 1: caret is inside a text node
      if (range.startContainer.nodeType === Node.TEXT_NODE) {
        const textNode = range.startContainer as Text;
        const text = textNode.textContent ?? '';
        const offset = range.startOffset;
        if (offset > 0 && text[offset - 1] === '@') {
          const before = text.slice(0, offset - 1);
          const after = text.slice(offset);
          const frag = document.createDocumentFragment();
          if (before) frag.appendChild(document.createTextNode(before));
          const atSpan = makeAtSpan();
          frag.appendChild(atSpan);
          if (after) frag.appendChild(document.createTextNode(after));
          textNode.parentNode?.replaceChild(frag, textNode);

          const r = document.createRange();
          r.setStartAfter(atSpan);
          r.collapse(true);
          sel.removeAllRanges();
          sel.addRange(r);
          return atSpan;
        }
      }

      // Case 2: caret is in an element node, check previous sibling text
      if (range.startContainer.nodeType === Node.ELEMENT_NODE) {
        const parent = range.startContainer as Element;
        const idx = range.startOffset;
        const prev = idx > 0 ? parent.childNodes[idx - 1] : null;
        if (prev && prev.nodeType === Node.TEXT_NODE) {
          const textNode = prev as Text;
          const text = textNode.textContent ?? '';
          if (text.endsWith('@')) {
            const before = text.slice(0, -1);
            const after = '';
            const frag = document.createDocumentFragment();
            if (before) frag.appendChild(document.createTextNode(before));
            const atSpan = makeAtSpan();
            frag.appendChild(atSpan);
            if (after) frag.appendChild(document.createTextNode(after));
            textNode.parentNode?.replaceChild(frag, textNode);

            const r = document.createRange();
            r.setStartAfter(atSpan);
            r.collapse(true);
            sel.removeAllRanges();
            sel.addRange(r);
            return atSpan;
          }
        }
      }

      return null;
    };

    /** Removes a leading `<br>` some browsers insert after deletes and restores the caret. */
    const normalizeLeadingBr = () => {
      const el = editableRef.current;
      if (!el) return;
      const first = el.firstChild;
      if (first?.nodeName !== 'BR') return;
      if (!el.querySelector('span[data-resource]')) return;
      const sel = window.getSelection();
      const range = document.createRange();
      range.setStart(el, 0);
      range.collapse(true);
      first.remove();
      if (sel) {
        sel.removeAllRanges();
        sel.addRange(range);
      }
    };

    const handleInput = () => {
      updateEmpty();
      const ed = editableRef.current;
      if (ed) {
        notifyCanvasPickSurfaceRemovedFromDiff(scanCanvasPickSurfaceIds(ed));
      }
      onHtmlChange?.(editableRef.current?.innerHTML ?? '');
      queueMicrotask(scrollEditableToBottom);
      queueMicrotask(normalizeLeadingBr);
      queueMicrotask(() => {
        const atSpan = wrapAtBeforeCaretInSpan();
        if (atSpan) {
          atAnchorElRef.current = atSpan;
          openAtPanel();
          return;
        }
        atAnchorElRef.current = null;
        closeAtPanel();
      });
    };

    const insertChipAtCaret = (chip: HTMLElement) => {
      const el = editableRef.current;
      if (!el) return;
      const sel = window.getSelection();
      let range: Range | null = null;
      if (sel && sel.rangeCount > 0) {
        const liveRange = sel.getRangeAt(0);
        if (el.contains(liveRange.commonAncestorContainer)) {
          range = liveRange;
        }
      }
      if (!range) {
        const savedRange = canvasPickCaretRangeRef.current;
        if (isRangeInsideEditable(savedRange, el)) {
          range = savedRange.cloneRange();
        }
      }
      if (!range) {
        // No caret yet (editor never focused): create one at end of content.
        el.focus();
        const r = document.createRange();
        r.selectNodeContents(el);
        r.collapse(false);
        sel?.removeAllRanges();
        sel?.addRange(r);
        canvasPickCaretRangeRef.current = r.cloneRange();
        range = r;
      }
      range.insertNode(chip);
      range.setStartAfter(chip);
      range.setEndAfter(chip);
      if (sel) {
        sel.removeAllRanges();
        sel.addRange(range);
      }
      canvasPickCaretRangeRef.current = range.cloneRange();
      el.focus();
      updateEmpty();
      onHtmlChange?.(editableRef.current?.innerHTML ?? '');
      queueMicrotask(scrollEditableToBottom);
      syncCanvasPickRefsFromDom();
    };

    const isRangeInsideEditable = (range: Range | null, el: HTMLDivElement): range is Range => {
      if (!range) return false;
      try {
        return document.contains(range.startContainer) && el.contains(range.commonAncestorContainer);
      } catch {
        return false;
      }
    };

    const findCanvasPickPlaceholderEl = (el: HTMLDivElement, placeholderId: string): Element | null => {
      let found: Element | null = null;
      el.querySelectorAll(`span[${canvasPickPlaceholderAttr}]`).forEach((node) => {
        if (node.getAttribute(canvasPickPlaceholderAttr) === placeholderId) found = node;
      });
      return found;
    };

    const scanCanvasPickSurfaceIds = (el: HTMLDivElement) => {
      const placeholders = new Set<string>();
      el.querySelectorAll(`span[${canvasPickPlaceholderAttr}]`).forEach((node) => {
        const id = node.getAttribute(canvasPickPlaceholderAttr);
        if (id) placeholders.add(id);
      });
      const chips = new Set<string>();
      el.querySelectorAll(`span[data-resource][${canvasPickChipIdAttr}]`).forEach((node) => {
        const id = node.getAttribute(canvasPickChipIdAttr);
        if (id) chips.add(id);
      });
      return { placeholders, chips };
    };

    /** After imperative DOM updates: refresh refs without firing removal callbacks. */
    const syncCanvasPickRefsFromDom = () => {
      const el = editableRef.current;
      if (!el) return;
      const now = scanCanvasPickSurfaceIds(el);
      prevCanvasPickPlaceholdersRef.current = now.placeholders;
      prevCanvasPickChipsRef.current = now.chips;
    };

    /** After user edits (or full HTML replace): notify when a pick pill/chip disappeared from the document. */
    const notifyCanvasPickSurfaceRemovedFromDiff = (now: { placeholders: Set<string>; chips: Set<string> }) => {
      if (onCanvasPickSurfaceRemoved) {
        const prevPh = prevCanvasPickPlaceholdersRef.current;
        const prevCh = prevCanvasPickChipsRef.current;
        prevPh.forEach((id) => {
          if (!now.placeholders.has(id) && !now.chips.has(id)) {
            onCanvasPickSurfaceRemoved({ placeholderId: id, surface: 'recognizing' });
          }
        });
        prevCh.forEach((id) => {
          if (!now.chips.has(id)) {
            onCanvasPickSurfaceRemoved({ placeholderId: id, surface: 'chip' });
          }
        });
      }
      prevCanvasPickPlaceholdersRef.current = now.placeholders;
      prevCanvasPickChipsRef.current = now.chips;
    };

    const appendCanvasPickRecognizingPlaceholder = (placeholderId: string): boolean => {
      const el = editableRef.current;
      if (!el) return false;
      if (findCanvasPickPlaceholderEl(el, placeholderId)) return true;
      const span = document.createElement('span');
      span.setAttribute(canvasPickPlaceholderAttr, placeholderId);
      span.setAttribute('contenteditable', 'false');
      span.className =
        'mr-1 inline-flex max-w-[126px] min-w-0 shrink-0 items-center gap-1 whitespace-nowrap rounded-full border border-[var(--color-border-default-base)] bg-[var(--color-background-default-secondary)] px-2 py-0.5 text-xs font-medium text-[var(--color-text-default-base)]';
      span.textContent = '⏳ 识别中...';

      // Prefer per-placeholder captured caret so concurrent recognitions keep independent positions.
      // Fall back to live/saved caret only when no captured position exists.
      const sel = window.getSelection();
      let insertRange: Range | null = null;
      const registryRange = consumeCanvasPickCaretRange(placeholderId);
      if (isRangeInsideEditable(registryRange, el)) {
        insertRange = registryRange.cloneRange();
      }
      if (!insertRange && sel && sel.rangeCount > 0) {
        const r = sel.getRangeAt(0);
        if (el.contains(r.commonAncestorContainer)) insertRange = r;
      }
      if (!insertRange) {
        const saved = canvasPickCaretRangeRef.current;
        if (isRangeInsideEditable(saved, el)) insertRange = saved.cloneRange();
      }
      if (!insertRange) return false;

      insertRange.insertNode(span);
      // Advance caret range so multiple inserts stay stable and ordered.
      try {
        insertRange.setStartAfter(span);
        insertRange.collapse(true);
        if (sel) {
          sel.removeAllRanges();
          sel.addRange(insertRange);
        }
        canvasPickCaretRangeRef.current = insertRange.cloneRange();
      } catch {
        // ignore
      }
      updateEmpty();
      onHtmlChange?.(el.innerHTML);
      syncCanvasPickRefsFromDom();
      return true;
    };

    const removeCanvasPickPlaceholder = (placeholderId: string) => {
      const el = editableRef.current;
      if (!el) return;
      findCanvasPickPlaceholderEl(el, placeholderId)?.remove();
      updateEmpty();
      onHtmlChange?.(el.innerHTML);
      syncCanvasPickRefsFromDom();
    };

    const replaceCanvasPickPlaceholderWithImageChip = (
      placeholderId: string,
      url: string,
      name: string,
      type: AgentResourceType = 'image',
    ) => {
      const el = editableRef.current;
      if (!el) return;
      const hit = findCanvasPickPlaceholderEl(el, placeholderId);
      if (!hit?.parentNode) return;
      const chip = createChip(url, name || 'Image', type);
      chip.setAttribute(canvasPickChipIdAttr, placeholderId);

      const sel = window.getSelection();
      const hadSelectionInEditor = sel && sel.rangeCount > 0 && sel.anchorNode && el.contains(sel.anchorNode);
      let savedRange: Range | undefined;
      // Track whether the saved caret was sitting at or after the placeholder in its
      // parent node.  When true, we need to explicitly move the cursor past the chip
      // after replacement, because browsers snap a range.startOffset that points past
      // a contenteditable=false element to *before* that element at line end.
      let savedRangeWasAfterPlaceholder = false;

      if (hadSelectionInEditor) {
        try {
          savedRange = sel.getRangeAt(0).cloneRange();
          const parent = hit.parentNode;
          const placeholderIdx = Array.from(parent.childNodes).indexOf(hit as ChildNode);
          if (savedRange.startContainer === parent && savedRange.startOffset > placeholderIdx) {
            savedRangeWasAfterPlaceholder = true;
          }
        } catch {
          /* ignore */
        }
      }

      hit.parentNode.replaceChild(chip, hit);

      if (hadSelectionInEditor && sel) {
        try {
          if (savedRangeWasAfterPlaceholder) {
            // Keep the browser-adjusted logical range (so multi-placeholder replacements keep order),
            // but guard against Safari/Chromium occasionally snapping to BEFORE the new chip.
            if (savedRange) {
              const parent = chip.parentNode;
              if (parent) {
                const chipIdx = Array.from(parent.childNodes).indexOf(chip);
                if (savedRange.startContainer === parent && savedRange.startOffset <= chipIdx) {
                  savedRange.setStart(parent, chipIdx + 1);
                  savedRange.collapse(true);
                }
              }
              sel.removeAllRanges();
              sel.addRange(savedRange);
              canvasPickCaretRangeRef.current = savedRange.cloneRange();
            }
          } else if (savedRange) {
            sel.removeAllRanges();
            sel.addRange(savedRange);
          }
        } catch {
          /* ignore */
        }
      }

      updateEmpty();
      onHtmlChange?.(el.innerHTML);
      syncCanvasPickRefsFromDom();
    };

    const replaceCanvasPickChipById = (
      placeholderId: string,
      url: string,
      name: string,
      type: AgentResourceType = 'image',
    ) => {
      const el = editableRef.current;
      if (!el) return;
      const hit = el.querySelector(`span[data-resource][${canvasPickChipIdAttr}="${placeholderId}"]`);
      if (!hit?.parentNode) return;
      const sel = window.getSelection();
      const hadSelectionInEditor = Boolean(sel && sel.rangeCount > 0 && sel.anchorNode && el.contains(sel.anchorNode));
      const caretMarkerAttr = 'data-agent-caret-marker';
      let caretMarker: HTMLSpanElement | null = null;
      if (hadSelectionInEditor && sel) {
        try {
          const r = sel.getRangeAt(0).cloneRange();
          r.collapse(false);
          caretMarker = document.createElement('span');
          caretMarker.setAttribute(caretMarkerAttr, 'true');
          caretMarker.setAttribute('contenteditable', 'false');
          caretMarker.style.cssText =
            'display:inline-block;width:0;height:0;overflow:hidden;line-height:0;pointer-events:none;';
          caretMarker.textContent = '\u200b';
          r.insertNode(caretMarker);
        } catch {
          caretMarker = null;
        }
      }
      const chip = createChip(url, name || 'Image', type);
      chip.setAttribute(canvasPickChipIdAttr, placeholderId);
      hit.parentNode.replaceChild(chip, hit);
      if (caretMarker && sel && document.contains(caretMarker)) {
        try {
          const nextRange = document.createRange();
          nextRange.setStartAfter(caretMarker);
          nextRange.collapse(true);
          sel.removeAllRanges();
          sel.addRange(nextRange);
          canvasPickCaretRangeRef.current = nextRange.cloneRange();
          caretMarker.remove();
        } catch {
          caretMarker.remove();
        }
      }
      updateEmpty();
      onHtmlChange?.(el.innerHTML);
      syncCanvasPickRefsFromDom();
    };

    const handleAddImageFromUrl = (url: string) => insertChipAtCaret(createChip(url, 'Image', 'image'));
    const handleAddResourceFromUrl = (url: string, name: string, type: AgentResourceType) => insertChipAtCaret(createChip(url, name || 'File', type));
    const handleClear = () => {
      if (!editableRef.current) return;
      if (onCanvasPickSurfaceRemoved) {
        prevCanvasPickPlaceholdersRef.current.forEach((id) => {
          onCanvasPickSurfaceRemoved({ placeholderId: id, surface: 'recognizing' });
        });
        prevCanvasPickChipsRef.current.forEach((id) => {
          onCanvasPickSurfaceRemoved({ placeholderId: id, surface: 'chip' });
        });
      }
      prevCanvasPickPlaceholdersRef.current = new Set();
      prevCanvasPickChipsRef.current = new Set();
      editableRef.current.innerHTML = '';
      setEmpty(true);
      onEmptyChange?.(true);
      onHtmlChange?.('');
    };
    const handleGetHtml = () => editableRef.current?.innerHTML ?? '';
    const handleSetHtml = (html: string) => {
      const el = editableRef.current;
      if (!el) return;
      el.innerHTML = html;
      updateEmpty();
      onHtmlChange?.(el.innerHTML);
      queueMicrotask(scrollEditableToBottom);
      notifyCanvasPickSurfaceRemovedFromDiff(scanCanvasPickSurfaceIds(el));
    };
    const handleIsEmpty = () => {
      const text = editableRef.current?.innerText?.replace(/\u00A0/g, ' ').trim() ?? '';
      return text.length === 0;
    };

    const focusEditor = () => {
      const el = editableRef.current;
      if (!el) return;
      const wasFocused = document.activeElement === el;
      el.focus();
      const sel = window.getSelection();
      if (!sel) return;
      if (wasFocused && sel.rangeCount > 0) {
        const r = sel.getRangeAt(0);
        if (el.contains(r.commonAncestorContainer)) return;
      }
      const r = document.createRange();
      r.selectNodeContents(el);
      r.collapse(false);
      sel.removeAllRanges();
      sel.addRange(r);
      canvasPickCaretRangeRef.current = r.cloneRange();
    };

    const openMentionPanelFromToolbar = () => {
      if (!hasAtPanelContent) return;
      atAnchorElRef.current = null;
      atRefs.setReference(editableRef.current);
      setShowAtPanel(true);
      queueMicrotask(() => focusEditor());
    };

    useImperativeHandle(ref, () => ({
      addImageFromUrl: handleAddImageFromUrl,
      addResourceFromUrl: handleAddResourceFromUrl,
      focusEditor,
      clear: handleClear,
      getHtml: handleGetHtml,
      isEmpty: handleIsEmpty,
      openMentionPanel: openMentionPanelFromToolbar,
      appendCanvasPickRecognizingPlaceholder,
      removeCanvasPickPlaceholder,
      replaceCanvasPickPlaceholderWithImageChip,
      replaceCanvasPickChipById,
      setHtml: handleSetHtml,
    }));

    const handleEditablePaste = (e: React.ClipboardEvent<HTMLDivElement>) => {
      e.preventDefault();
      const text = e.clipboardData.getData('text/plain');
      const el = editableRef.current;
      if (!el) return;

      const selection = window.getSelection();
      if (!selection || selection.rangeCount === 0) return;

      const range = selection.getRangeAt(0);
      if (!el.contains(range.commonAncestorContainer)) {
        // When caret is outside the editable, fallback to appending at end.
        range.selectNodeContents(el);
        range.collapse(false);
      }

      range.deleteContents();

      const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
      const parts = normalized.split('\n');
      const frag = document.createDocumentFragment();

      let lastInserted: Node | null = null;
      parts.forEach((part, idx) => {
        const textNode = document.createTextNode(part);
        frag.appendChild(textNode);
        lastInserted = textNode;

        if (idx < parts.length - 1) {
          const br = document.createElement('br');
          frag.appendChild(br);
          lastInserted = br;
        }
      });

      range.insertNode(frag);

      // Move caret after the last inserted node for a consistent editing experience.
      if (lastInserted) {
        range.setStartAfter(lastInserted);
        range.setEndAfter(lastInserted);
      }
      selection.removeAllRanges();
      selection.addRange(range);

      updateEmpty();
      queueMicrotask(scrollEditableToBottom);
      queueMicrotask(() => {
        const root = editableRef.current;
        if (root) notifyCanvasPickSurfaceRemovedFromDiff(scanCanvasPickSurfaceIds(root));
      });
    };

    const handleEditableKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key === 'Escape') {
        closeAtPanel();
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        closeAtPanel();
        onEnterSend?.();
      }
    };

    const handleAtPanelSelect = (source: AgentAtPanelSourceItem) => {
      const removeAtTriggerToken = (): { parent: Node; nextSibling: ChildNode | null } | null => {
        const el = editableRef.current;
        if (!el) return null;
        const atSpans = el.querySelectorAll('span[data-chat-at="true"]');
        const target = atAnchorElRef.current ?? (atSpans.length ? (atSpans[atSpans.length - 1] as HTMLElement) : null);
        if (!target || !el.contains(target)) return null;
        const parent = target.parentNode;
        if (!parent) return null;
        const nextSibling = target.nextSibling;
        target.remove();
        atAnchorElRef.current = null;
        return { parent, nextSibling };
      };

      let chipToInsert: HTMLElement | null = null;
      if (source.kind === 'upstream') {
        const url = source.item.previewUrl;
        if (url) {
          const type = source.item.mediaType ?? 'file';
          const label = source.item.name ?? defaultLabelByResourceType[type];
          chipToInsert = createChip(url, label, type);
        }
      } else {
        const item = source.item;
        const url = item.previewUrl ?? '';
        const label = item.name ?? defaultLabelByResourceType[item.type];

        // @-panel uploads: insert chips for every supported modality
        chipToInsert = createChip(url, label, item.type);
      }

      const insertPoint = removeAtTriggerToken();
      closeAtPanel();

      window.setTimeout(() => {
        requestAnimationFrame(() => {
          editableRef.current?.focus();
          if (insertPoint) {
            const sel = window.getSelection();
            if (sel) {
              const r = document.createRange();
              if (insertPoint.nextSibling) r.setStartBefore(insertPoint.nextSibling);
              else r.setStart(insertPoint.parent, insertPoint.parent.childNodes.length);
              r.collapse(true);
              sel.removeAllRanges();
              sel.addRange(r);
            }
          }
          if (chipToInsert) insertChipAtCaret(chipToInsert);
        });
      }, 0);
    };

    return (
      <div className='relative min-h-[72px] max-h-[200px] flex-1 cursor-text overflow-hidden'>
        {empty && (
          <div className='pointer-events-none absolute inset-0 p-2 text-sm leading-relaxed text-[var(--color-text-default-tertiary)] whitespace-pre-wrap'>
            {placeholderLines.map((line, i) => (
              <span key={i} className='block'>
                {line}
              </span>
            ))}
          </div>
        )}
        <div
          ref={editableRef}
          contentEditable={!disabled}
          suppressContentEditableWarning
          role='textbox'
          aria-multiline='true'
          className={cn(
            'min-h-[44px] max-h-[200px] cursor-text overflow-y-auto p-2 text-sm leading-relaxed text-[var(--color-text-default-base)] outline-none',
            className,
          )}
          onInput={handleInput}
          onPaste={handleEditablePaste}
          onKeyDown={handleEditableKeyDown}
          onFocus={() => onFocusChange?.(true)}
          onBlur={() => onFocusChange?.(false)}
          data-agent-canvas-pick-source-id={canvasPickSourceId}
        />
        <AgentFloatingPopover
          open={showAtPanel && hasAtPanelContent}
          refs={atRefs}
          floatingStyles={atFloatingStyles}
          className='z-[530]'
        >
          <div className='max-w-[320px] w-auto rounded-lg border border-[var(--color-border-default-base)] bg-[var(--color-background-default-base)] p-1 text-xs text-[var(--color-text-default-tertiary)]'>
            <AgentAtPanel upstreamItems={upstreamItems} uploadItems={uploadItems} onSelect={handleAtPanelSelect} />
          </div>
        </AgentFloatingPopover>
      </div>
    );
  },
);

export default AgentComposerInput;
