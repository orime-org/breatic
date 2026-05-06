import {
  KeyboardEvent,
  ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { autoUpdate, flip, offset, shift, useFloating } from '@floating-ui/react';
import type { Editor } from '@tiptap/react';
import { TextSelection } from '@tiptap/pm/state';
import {
  RiArrowUpLine,
  RiArrowGoBackFill,
  RiCheckFill,
  RiCloseLine,
  RiContractUpDownLine,
  RiExchangeLine,
  RiExpandUpDownLine,
  RiLoopLeftFill,
  RiPlayListAddLine,
  RiSparkling2Line,
  RiTranslateAi,
} from 'react-icons/ri';
import { FaStopCircle } from 'react-icons/fa';
import { Button } from '@/ui/button';
import { cn } from '@/utils/classnames';
import { AiErrorIcon } from './TextEditorIcons';

// ── Types ────────────────────────────────────────────────────────────────────

type AIStatus = 'quick-actions' | 'user-input' | 'thinking' | 'ai-writing' | 'user-reviewing' | 'error';

interface AISuggestionItem {
  key: string;
  title: string;
  icon: ReactNode;
  onClick: () => void;
}

type SelectionToolKey = 'polish' | 'expand' | 'summarize' | 'translate' | 'rewrite' | 'continue';

type TextToolMockPayload =
  | { tool: 'polish' | 'expand' | 'summarize' | 'continue'; document: string; selection: string; instructions?: string; node_id?: string; project_id?: string }
  | { tool: 'translate'; document: string; selection: string; language: string; instructions?: string; node_id?: string; project_id?: string }
  | { tool: 'rewrite'; document: string; selection: string; style?: string; instructions?: string; node_id?: string; project_id?: string }
  | { tool: 'generate'; instructions: string; document?: string; node_id?: string; project_id?: string }
  | { tool: 'character'; name: string; traits?: string; context?: string; document?: string; node_id?: string; project_id?: string }
  | { tool: 'storyboard'; instructions: string; scene_count?: number; document?: string; node_id?: string; project_id?: string }
  | { tool: 'script'; scene_description: string; characters?: string[]; document?: string; node_id?: string; project_id?: string };

type MockTool = TextToolMockPayload['tool'];

type QuickActionMeta = {
  key: SelectionToolKey;
  title: string;
  icon: ReactNode;
};

const MOCK_TOOL_REPLACEMENTS: Record<MockTool, string> = {
  generate: '[GENERATE] This is fixed replacement content.',
  character: '[CHARACTER] This is fixed replacement content.',
  storyboard: '[STORYBOARD] This is fixed replacement content.',
  script: '[SCRIPT] This is fixed replacement content.',
  polish: '[POLISH] This is fixed replacement content.',
  expand: '[EXPAND] This is fixed replacement content.',
  summarize: '[SUMMARIZE] This is fixed replacement content.',
  translate: '[TRANSLATE] This is fixed replacement content.',
  rewrite: '[REWRITE] This is fixed replacement content.',
  continue: '[CONTINUE] This is fixed replacement content.',
};

const QUICK_ACTION_META: readonly QuickActionMeta[] = [
  { key: 'polish', title: 'Polish', icon: <RiSparkling2Line size={16} /> },
  { key: 'expand', title: 'Expand', icon: <RiExpandUpDownLine size={16} /> },
  { key: 'summarize', title: 'Summarize', icon: <RiContractUpDownLine size={16} /> },
  { key: 'translate', title: 'Translate', icon: <RiTranslateAi size={16} /> },
  { key: 'rewrite', title: 'Rewrite', icon: <RiExchangeLine size={16} /> },
  { key: 'continue', title: 'Continue', icon: <RiPlayListAddLine size={16} /> },
] as const;

export interface AIMenuProps {
  editor: Editor;
  anchorPos: number;
  anchorRect?: DOMRect | null;
  onClose: () => void;
  menuVariant?: 'selection' | 'generation';
  onPreviewApplied?: () => void;
  initialReplacement?: string | null;
}

const getBlockVerticalBounds = (editor: Editor, blockStartPos: number): { top: number; bottom: number } => {
  const { doc } = editor.state;
  const safePos = Math.max(0, Math.min(blockStartPos, doc.content.size));
  const $pos = doc.resolve(safePos);

  let targetDepth = 1;
  for (let d = $pos.depth; d >= 1; d -= 1) {
    if ($pos.start(d) === safePos) {
      targetDepth = d;
      break;
    }
  }

  const blockTopPos = $pos.start(targetDepth);
  const blockBottomPos = $pos.end(targetDepth);
  const topCoords = editor.view.coordsAtPos(blockTopPos);
  const bottomCoords = editor.view.coordsAtPos(blockBottomPos);

  return {
    top: topCoords.top,
    bottom: bottomCoords.bottom,
  };
};

const clearAIGenerationPlaceholderIfNeeded = (editor: Editor, pos: number): void => {
  try {
    const docSize = editor.state.doc.content.size;
    const safePos = Math.max(1, Math.min(pos, Math.max(1, docSize)));
    const $pos = editor.state.doc.resolve(safePos);
    for (let d = $pos.depth; d >= 1; d -= 1) {
      const node = $pos.node(d);
      if (node.type.name !== 'highlightBlock') continue;
      if (node.attrs?.aiPlaceholder !== true) continue;
      const blockStart = $pos.start(d);
      editor.chain().focus().setTextSelection(blockStart).setParagraph().run();
      return;
    }
  } catch {
    // no-op
  }
};

// ── Main component ────────────────────────────────────────────────────────────

const AIMenu = ({
  editor,
  anchorPos,
  anchorRect = null,
  onClose,
  menuVariant = 'selection',
  onPreviewApplied,
  initialReplacement = null,
}: AIMenuProps) => {
  const [status, setStatus] = useState<AIStatus>(() =>
    menuVariant === 'generation' && !initialReplacement ? 'user-input' : 'quick-actions',
  );
  const [prompt, setPrompt] = useState('');
  const [isPromptFocused, setIsPromptFocused] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const editorRectRef = useRef<DOMRect | null>(null);
  const openedAtRef = useRef<number>(Date.now());
  const timersRef = useRef<number[]>([]);
  const previewRef = useRef<{ from: number; to: number; originalText: string } | null>(null);
  const selectionRangeRef = useRef<{ from: number; to: number } | null>(null);
  const tempSelectionHighlightRef = useRef(false);

  const previewColor = '#2563EB';

  const { refs, floatingStyles, update, placement } = useFloating({
    open: true,
    placement: 'bottom-start',
    strategy: 'fixed',
    middleware: [
      offset(10),
      flip({
        fallbackPlacements: ['top-start', 'bottom-end', 'top-end'],
        padding: 8,
      }),
      shift({ padding: 8 }),
    ],
    whileElementsMounted: autoUpdate,
  });

  const menuPlacedOnTop = placement.startsWith('top');

  const reference = useMemo(() => {
    const editorDom = editor.view.dom as HTMLElement;
    const anchorToTop = placement.startsWith('top');
    return {
      contextElement: editorDom,
      getBoundingClientRect: () => {
        if (anchorRect) {
          const anchorY = anchorToTop ? anchorRect.top : anchorRect.bottom;
          return {
            x: anchorRect.left,
            y: anchorY,
            width: anchorRect.width,
            height: 1,
            top: anchorY,
            left: anchorRect.left,
            right: anchorRect.left + anchorRect.width,
            bottom: anchorY + 1,
          };
        }

        const bounds = getBlockVerticalBounds(editor, anchorPos);
        const editorRect = editorDom.getBoundingClientRect();
        const anchorY = anchorToTop ? bounds.top : bounds.bottom;
        editorRectRef.current = editorRect;
        return {
          x: editorRect.left,
          y: anchorY,
          width: editorRect.width,
          height: 1,
          top: anchorY,
          left: editorRect.left,
          right: editorRect.left + editorRect.width,
          bottom: anchorY + 1,
        };
      },
    };
  }, [editor, anchorPos, anchorRect, placement]);

  useLayoutEffect(() => {
    refs.setReference(reference);
    update();
  }, [refs, reference, update]);

  useLayoutEffect(() => {
    if (menuVariant !== 'generation' || initialReplacement) return;
    if (status !== 'user-input') return;
    inputRef.current?.focus();
  }, [menuVariant, initialReplacement, status]);

  useEffect(() => {
    const onViewportChanged = () => update();
    window.addEventListener('scroll', onViewportChanged, true);
    window.addEventListener('resize', onViewportChanged);
    return () => {
      window.removeEventListener('scroll', onViewportChanged, true);
      window.removeEventListener('resize', onViewportChanged);
    };
  }, [update]);

  const clearTimers = useCallback(() => {
    for (const id of timersRef.current) window.clearTimeout(id);
    timersRef.current = [];
  }, []);

  const focusPromptInput = useCallback(() => {
    const input = inputRef.current;
    if (!input) return;
    input.focus({ preventScroll: true });
    const caretPos = input.value.length;
    input.setSelectionRange(caretPos, caretPos);
  }, []);

  const clearTemporarySelectionHighlight = useCallback(() => {
    if (!tempSelectionHighlightRef.current) return;
    const range = selectionRangeRef.current;
    const highlightMark = editor.state.schema.marks.highlight;
    if (!range || !highlightMark) return;
    const tr = editor.state.tr.removeMark(range.from, range.to, highlightMark);
    editor.view.dispatch(tr);
    tempSelectionHighlightRef.current = false;
  }, [editor]);

  useEffect(() => {
    if (menuVariant !== 'selection') {
      selectionRangeRef.current = null;
      tempSelectionHighlightRef.current = false;
      return;
    }
    const sel = editor.state.selection;
    if (!(sel instanceof TextSelection) || sel.empty) {
      selectionRangeRef.current = null;
      tempSelectionHighlightRef.current = false;
      return;
    }
    const from = Math.min(sel.from, sel.to);
    const to = Math.max(sel.from, sel.to);
    selectionRangeRef.current = { from, to };

    const highlightMark = editor.state.schema.marks.highlight;
    if (!highlightMark) return;
    const tr = editor.state.tr.addMark(from, to, highlightMark.create());
    editor.view.dispatch(tr);
    tempSelectionHighlightRef.current = true;

    return () => {
      clearTemporarySelectionHighlight();
    };
  }, [clearTemporarySelectionHighlight, editor, menuVariant]);

  const revertPreview = useCallback(() => {
    const preview = previewRef.current;
    if (!preview) return;
    const { from, to, originalText } = preview;
    editor
      .chain()
      .focus()
      .insertContentAt({ from, to }, originalText)
      .setTextSelection(from + originalText.length)
      .unsetColor()
      .run();
    previewRef.current = null;
  }, [editor]);

  const closeMenu = useCallback(
    (options?: { revertPreview?: boolean }) => {
      clearTimers();
      if (options?.revertPreview !== false) revertPreview();
      clearTemporarySelectionHighlight();
      onClose();
    },
    [clearTemporarySelectionHighlight, clearTimers, onClose, revertPreview],
  );

  const acceptPreview = useCallback(() => {
    const preview = previewRef.current;
    if (!preview) {
      closeMenu({ revertPreview: false });
      return;
    }
    editor
      .chain()
      .focus()
      .setTextSelection({ from: preview.from, to: preview.to })
      .unsetColor()
      .setTextSelection(preview.to)
      .run();
    previewRef.current = null;
    closeMenu({ revertPreview: false });
  }, [closeMenu, editor]);

  const applyPreviewReplacement = useCallback(
    (replacement: string) => {
      try {
        clearTemporarySelectionHighlight();
        const fallbackSel = editor.state.selection;
        let from: number;
        let to: number;
        let originalText = '';

        // Retry should replace the current preview range directly, otherwise
        // stale selection ranges can leave trailing text behind.
        const existingPreview = previewRef.current;
        if (existingPreview) {
          from = existingPreview.from;
          to = existingPreview.to;
          originalText = existingPreview.originalText;
        } else if (menuVariant === 'generation') {
          const docSize = editor.state.doc.content.size;
          const insertPos = Math.max(1, Math.min(Math.max(fallbackSel.from, fallbackSel.to), docSize));
          from = insertPos;
          to = insertPos;
        } else {
          const preferredRange = selectionRangeRef.current;
          from = preferredRange?.from ?? Math.min(fallbackSel.from, fallbackSel.to);
          to = preferredRange?.to ?? Math.max(fallbackSel.from, fallbackSel.to);
          if (to <= from) return false;
          originalText = editor.state.doc.textBetween(from, to, '\n', '\n');
        }

        const previewApplied = editor
          .chain()
          .focus()
          .insertContentAt({ from, to }, replacement)
          .setTextSelection({ from, to: from + replacement.length })
          .setColor(previewColor)
          .setTextSelection(from + replacement.length)
          .run();
        if (!previewApplied) return false;

        if (menuVariant === 'generation') {
          clearAIGenerationPlaceholderIfNeeded(editor, Math.max(from + 1, 1));
        }

        // Clear stored textStyle mark for subsequent typing without touching preview color.
        editor.chain().focus().unsetMark('textStyle').run();
        previewRef.current = { from, to: from + replacement.length, originalText };
        onPreviewApplied?.();
        return true;
      } catch (err) {
        console.error('[AIMenu] Failed to apply AI preview replacement', err);
        return false;
      }
    },
    [clearTemporarySelectionHighlight, editor, menuVariant, onPreviewApplied],
  );

  const runPreviewFlow = useCallback(
    (replacement: string) => {
      clearTimers();
      setStatus('thinking');
      const thinkingTimer = window.setTimeout(() => {
        setStatus('ai-writing');
        const writingTimer = window.setTimeout(() => {
          try {
            const ok = applyPreviewReplacement(replacement);
            setStatus(ok ? 'user-reviewing' : 'error');
          } catch (err) {
            console.error('[AIMenu] Failed during AI writing phase', err);
            setStatus('error');
          }
        }, 550);
        timersRef.current.push(writingTimer);
      }, 700);
      timersRef.current.push(thinkingTimer);
    },
    [applyPreviewReplacement, clearTimers],
  );

  useEffect(() => {
    if (!initialReplacement) return;
    runPreviewFlow(initialReplacement);
  }, [initialReplacement, runPreviewFlow]);

  // Close on click outside
  useEffect(() => {
    openedAtRef.current = Date.now();
    const handler = (e: MouseEvent) => {
      // Slash menu selection opens AI on the same click tick; ignore the first outside mousedown.
      if (Date.now() - openedAtRef.current < 180) return;
      if (menuRef.current?.contains(e.target as Node)) return;
      closeMenu();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [closeMenu]);

  const handleSuggestionClick = (item: AISuggestionItem) => {
    item.onClick();
  };

  const getMockReplacementByTool = useCallback((tool: MockTool): string => MOCK_TOOL_REPLACEMENTS[tool], []);

  const getDocumentText = useCallback((): string => {
    const size = editor.state.doc.content.size;
    return editor.state.doc.textBetween(1, Math.max(1, size), '\n', '\n');
  }, [editor]);

  const getSelectionText = useCallback((): string => {
    const preferred = selectionRangeRef.current;
    if (preferred && preferred.to > preferred.from) {
      return editor.state.doc.textBetween(preferred.from, preferred.to, '\n', '\n');
    }
    const sel = editor.state.selection;
    const from = Math.min(sel.from, sel.to);
    const to = Math.max(sel.from, sel.to);
    if (to <= from) return '';
    return editor.state.doc.textBetween(from, to, '\n', '\n');
  }, [editor]);

  const getPreviewText = useCallback((): string => {
    const preview = previewRef.current;
    if (!preview) return '';
    if (preview.to <= preview.from) return '';
    return editor.state.doc.textBetween(preview.from, preview.to, '\n', '\n');
  }, [editor]);

  const buildSelectionMockPayload = useCallback(
    (tool: SelectionToolKey): TextToolMockPayload | null => {
      const document = getDocumentText();
      const selection = getSelectionText() || getPreviewText();
      if (!document || !selection) return null;
      const trimmedPrompt = prompt.trim();

      if (tool === 'translate') {
        return {
          tool,
          document,
          selection,
          language: trimmedPrompt || 'English',
          instructions: trimmedPrompt || undefined,
        };
      }

      if (tool === 'rewrite') {
        return {
          tool,
          document,
          selection,
          style: trimmedPrompt || undefined,
          instructions: trimmedPrompt || undefined,
        };
      }

      return {
        tool,
        document,
        selection,
        instructions: trimmedPrompt || undefined,
      };
    },
    [getDocumentText, getPreviewText, getSelectionText, prompt],
  );

  const runMockTextTool = useCallback(
    (payload: TextToolMockPayload) => {
      runPreviewFlow(getMockReplacementByTool(payload.tool));
    },
    [getMockReplacementByTool, runPreviewFlow],
  );

  const handleSubmit = useCallback(() => {
    if (!prompt.trim()) return;
    if (menuVariant === 'generation' && status === 'user-input') {
      runPreviewFlow(MOCK_TOOL_REPLACEMENTS.generate);
      return;
    }
    runPreviewFlow('[AI PREVIEW] This is fixed replacement content.');
  }, [menuVariant, prompt, runPreviewFlow, status]);

  const handleStopGeneration = useCallback(() => {
    clearTimers();
    // Stopping generation should return to review mode immediately.
    setStatus('user-reviewing');
  }, [clearTimers]);

  const handleStopButtonKeyDown = useCallback(
    (e: KeyboardEvent<HTMLButtonElement>) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        handleStopGeneration();
      }
    },
    [handleStopGeneration],
  );

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault();
      handleSubmit();
    } else if (e.key === 'Escape') {
      closeMenu();
    }
  };

  const handleMenuMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const t = e.target as HTMLElement;
    if (t.closest('input, textarea, [contenteditable="true"]')) return;
    e.preventDefault();
  }, []);

  // ── Suggestion items based on status ────────────────────────────────────

  /** 结束输入框（审阅 / Discard·Apply）：聚焦时始终用这组快捷项。 */
  const quickActionItems: AISuggestionItem[] = useMemo(
    () =>
      QUICK_ACTION_META.map(({ key, title, icon }) => ({
        key,
        title,
        icon,
        onClick: () => {
          const payload = buildSelectionMockPayload(key);
          if (payload) runMockTextTool(payload);
        },
      })),
    [buildSelectionMockPayload, runMockTextTool],
  );

  const errorItems: AISuggestionItem[] = [
    {
      key: 'retry',
      title: 'Retry',
      icon: <RiLoopLeftFill size={16} />,
      onClick: () => runPreviewFlow('[RETRY] This is fixed replacement content.'),
    },
    {
      key: 'cancel',
      title: 'Cancel',
      icon: <RiArrowGoBackFill size={16} />,
      onClick: () => closeMenu(),
    },
  ];

  const getCurrentItems = (): AISuggestionItem[] => {
    if (status === 'user-reviewing') return quickActionItems;
    if (status === 'user-input') {
      return menuVariant === 'generation' ? [] : quickActionItems;
    }
    if (status === 'quick-actions') return quickActionItems;
    if (status === 'error') return errorItems;
    return [];
  };
  const currentItems: AISuggestionItem[] = getCurrentItems();
  const renderedItems: AISuggestionItem[] = menuPlacedOnTop ? [...currentItems].reverse() : currentItems;
  const showSuggestionList = status === 'quick-actions' && currentItems.length > 0;

  const isDisabled = status === 'thinking' || status === 'ai-writing';

  // Do not auto-focus; suggestions should only open after user interaction.
  useEffect(() => {
    if (status === 'user-reviewing') {
      requestAnimationFrame(() => focusPromptInput());
      setIsPromptFocused(true);
      return;
    }
    if (menuVariant === 'generation' && !initialReplacement && status === 'user-input') return;
    inputRef.current?.blur();
    setIsPromptFocused(false);
  }, [anchorPos, status, menuVariant, initialReplacement, focusPromptInput]);

  const getPlaceholder = (): string => {
    if (status === 'thinking') return 'Thinking…';
    if (status === 'ai-writing') return 'Editing…';
    if (status === 'error') return 'Oops! Something went wrong';
    return 'Ask AI anything…';
  };
  const placeholder = getPlaceholder();
  const isPromptEditable = status === 'user-input' || status === 'user-reviewing';
  let promptPlaceholder = placeholder;
  if (status === 'user-reviewing') {
    promptPlaceholder = 'Ask AI what you want...';
  }
  if (isPromptFocused) {
    promptPlaceholder = 'Ask AI what you want...';
  }

  const renderSubmitButton = useCallback(
    (extraClassName?: string) => (
      <Button
        type='default'
        size='medium'
        shape='circle'
        bordered={false}
        icon={<RiArrowUpLine size={15} />}
        onMouseDown={(e) => e.preventDefault()}
        onClick={handleSubmit}
        disabled={isDisabled || !prompt.trim()}
        aria-label='Submit AI prompt'
        className={cn(
          '!h-8 !w-8 shrink-0 !p-0 transition-colors',
          isDisabled || !prompt.trim()
            ? '!bg-background-default-secondary !text-text-default-tertiary'
            : '!bg-brand-base !text-white hover:!bg-brand-dark',
          extraClassName,
        )}
      />
    ),
    [handleSubmit, isDisabled, prompt],
  );

  const editorWidth =
    editorRectRef.current?.width ??
    (editor.view.dom as HTMLElement).getBoundingClientRect().width;
  const menuWidth = status === 'quick-actions' ? 'auto' : editorWidth;

  useEffect(() => {
    return () => {
      clearTimers();
    };
  }, [clearTimers]);

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div
      ref={(node) => {
        menuRef.current = node;
        refs.setFloating(node);
      }}
      data-breatic-text-editor-ai-menu
      onMouseDown={handleMenuMouseDown}
      style={{
        ...floatingStyles,
        width: menuWidth,
        zIndex: 100,
      }}
      className={cn('flex gap-1 outline-none', menuPlacedOnTop ? 'flex-col-reverse' : 'flex-col')}
    >
      {/* Prompt input area */}
      {status !== 'quick-actions' && (
        <div
          className={cn(
            'flex items-center gap-2 rounded-[12px] bg-background-default-base pl-3 pr-2',
            'border border-border-default-base',
            'shadow-[0px_1px_4px_0px_rgba(12,12,13,0.05),0px_8px_24px_rgba(12,12,13,0.12)]',
          )}
          style={{ minHeight: 56 }}
        >
          {isPromptEditable ? (
            <div className='flex w-full flex-col py-2'>
              <textarea
                ref={inputRef}
                rows={2}
                className='w-full resize-none bg-transparent text-[14px] text-text-default-base outline-none placeholder:text-text-default-tertiary'
                placeholder={promptPlaceholder}
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={handleKeyDown}
                onFocus={() => setIsPromptFocused(true)}
                onBlur={() => setIsPromptFocused(false)}
                autoComplete='off'
                aria-label={status === 'user-reviewing' ? 'AI follow-up prompt' : 'AI prompt'}
              />
              {status === 'user-reviewing' ? (
                <div className='mt-2 flex items-center gap-3 text-[14px]'>
                  <Button
                    bordered={false}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => runPreviewFlow('[RETRY] This is fixed replacement content.')}
                    className='inline-flex items-center gap-1 text-text-default-base hover:text-text-default-secondary'
                  >
                    <RiLoopLeftFill size={14} />
                    Try again
                  </Button>
                  <div className='ml-auto flex items-center gap-3'>
                    <Button
                      bordered={false}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => closeMenu()}
                      className='inline-flex items-center gap-1 text-text-default-secondary hover:text-text-default-base'
                    >
                      <RiCloseLine size={14} />
                      Discard
                    </Button>
                    <Button
                      shape='round'
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={acceptPreview}
                      className='inline-flex items-center gap-1 rounded-full bg-brand-base px-3 py-1 text-[14px] font-medium text-white hover:bg-brand-dark'
                    >
                      <RiCheckFill size={14} />
                      Apply
                    </Button>
                  </div>
                </div>
              ) : (
                <div className='mt-2 flex items-center'>
                  {renderSubmitButton('ml-auto')}
                </div>
              )}
            </div>
          ) : isDisabled ? (
            <>
              <div className='flex flex-1 items-center gap-2 py-3'>
                <span className='text-[14px] font-medium text-brand-base'>
                  {status === 'ai-writing' ? 'AI is writing' : 'Thinking'}
                </span>
                <span className='inline-flex items-center gap-1 text-text-default-tertiary'>
                  <span className='h-1.5 w-1.5 rounded-full bg-current opacity-60' />
                  <span className='h-1.5 w-1.5 rounded-full bg-current opacity-60' />
                  <span className='h-1.5 w-1.5 rounded-full bg-current opacity-60' />
                </span>
              </div>
              <Button
                type='default'
                size='small'
                shape='circle'
                bordered={false}
                icon={<FaStopCircle size={22} />}
                onMouseDown={(e) => e.preventDefault()}
                onClick={handleStopGeneration}
                onKeyDown={handleStopButtonKeyDown}
                aria-label='Stop AI generation'
              />
            </>
          ) : (
            <>
              <textarea
                ref={inputRef}
                rows={2}
                className='flex-1 resize-none bg-transparent py-1 text-[14px] text-text-default-base outline-none placeholder:text-text-default-tertiary disabled:pointer-events-none'
                placeholder={promptPlaceholder}
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={handleKeyDown}
                onFocus={() => setIsPromptFocused(true)}
                onBlur={() => setIsPromptFocused(false)}
                disabled={isDisabled}
                autoComplete='off'
                aria-label='AI prompt'
              />

              {status === 'error' ? (
                <span className='shrink-0 text-red-500'>
                  <AiErrorIcon size={16} />
                </span>
              ) : (
                renderSubmitButton()
              )}
            </>
          )}
        </div>
      )}

      {/* Suggestion list */}
      {showSuggestionList && (
        <div
          className={cn(
            'self-start min-w-[220px] overflow-hidden rounded-[8px] border border-border-default-base bg-background-default-base py-1',
            'shadow-[0px_1px_4px_0px_rgba(12,12,13,0.05),0px_8px_24px_rgba(12,12,13,0.12)]',
          )}
        >
          {renderedItems.map((item) => (
            <button
              key={item.key}
              type='button'
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => handleSuggestionClick(item)}
              className='flex w-full cursor-pointer items-center gap-2.5 rounded-md border-0 bg-transparent px-2.5 py-1.5 text-left text-[13px] text-text-default-base transition-colors hover:bg-background-default-secondary'
            >
              <span className='inline-flex h-6 w-6 shrink-0 items-center justify-center text-icon-base'>{item.icon}</span>
              {item.title}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

export default AIMenu;
