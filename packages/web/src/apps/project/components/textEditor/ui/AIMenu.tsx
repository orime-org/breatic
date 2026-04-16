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
  RiEdit2Line,
  RiListCheck2,
  RiLoopLeftFill,
  RiMagicLine,
  RiSparkling2Fill,
  RiTranslate2,
} from 'react-icons/ri';
import { FaStopCircle } from 'react-icons/fa';
import { LiaExpandSolid } from 'react-icons/lia';
import { LuUserRound } from 'react-icons/lu';
import { CgTranscript } from 'react-icons/cg';
import { IoClipboardOutline } from 'react-icons/io5';
import { MdOutlinePlaylistAdd } from 'react-icons/md';
import { Button } from '@/components/base/button';
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
  const [status, setStatus] = useState<AIStatus>('quick-actions');
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

      editor
        .chain()
        .focus()
        .insertContentAt({ from, to }, replacement)
        .setTextSelection({ from, to: from + replacement.length })
        .setColor(previewColor)
        .setTextSelection(from + replacement.length)
        .run();
      // Clear stored textStyle mark for subsequent typing without touching preview color.
      editor.chain().focus().unsetMark('textStyle').run();
      previewRef.current = { from, to: from + replacement.length, originalText };
      onPreviewApplied?.();
      return true;
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
          const ok = applyPreviewReplacement(replacement);
          setStatus(ok ? 'user-reviewing' : 'error');
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

  const handleSubmit = useCallback(() => {
    if (!prompt.trim()) return;
    runPreviewFlow('[AI PREVIEW] This is fixed replacement content.');
  }, [prompt, runPreviewFlow]);

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

  const selectionItems: AISuggestionItem[] = [
    {
      key: 'polish',
      title: 'polish',
      icon: <RiMagicLine size={16} />,
      onClick: () => runPreviewFlow('[POLISH] This is fixed replacement content.'),
    },
    {
      key: 'expand',
      title: 'expand',
      icon: <LiaExpandSolid size={16} />,
      onClick: () => runPreviewFlow('[EXPAND] This is fixed replacement content.'),
    },
    {
      key: 'summarize',
      title: 'summarize',
      icon: <RiListCheck2 size={16} />,
      onClick: () => runPreviewFlow('[SUMMARIZE] This is fixed replacement content.'),
    },
    {
      key: 'translate',
      title: 'translate',
      icon: <RiTranslate2 size={16} />,
      onClick: () => runPreviewFlow('[TRANSLATE] This is fixed replacement content.'),
    },
    {
      key: 'rewrite',
      title: 'rewrite',
      icon: <RiEdit2Line size={16} />,
      onClick: () => runPreviewFlow('[REWRITE] This is fixed replacement content.'),
    },
    {
      key: 'continue',
      title: 'continue',
      icon: <MdOutlinePlaylistAdd size={16} />,
      onClick: () => runPreviewFlow('[CONTINUE] This is fixed replacement content.'),
    },
  ];

  const generationItems: AISuggestionItem[] = [
    {
      key: 'generate',
      title: 'generate',
      icon: <RiSparkling2Fill size={16} />,
      onClick: () => runPreviewFlow('[GENERATE] This is fixed replacement content.'),
    },
    {
      key: 'character',
      title: 'character',
      icon: <LuUserRound size={16} />,
      onClick: () => runPreviewFlow('[CHARACTER] This is fixed replacement content.'),
    },
    {
      key: 'storyboard',
      title: 'storyboard',
      icon: <IoClipboardOutline size={16} />,
      onClick: () => runPreviewFlow('[STORYBOARD] This is fixed replacement content.'),
    },
    {
      key: 'script',
      title: 'script',
      icon: <CgTranscript size={16} />,
      onClick: () => runPreviewFlow('[SCRIPT] This is fixed replacement content.'),
    },
  ];

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
    if (status === 'quick-actions' || status === 'user-input' || status === 'user-reviewing') {
      return menuVariant === 'generation' ? generationItems : selectionItems;
    }
    if (status === 'error') return errorItems;
    return [];
  };
  const currentItems: AISuggestionItem[] = getCurrentItems();
  const renderedItems: AISuggestionItem[] = menuPlacedOnTop ? [...currentItems].reverse() : currentItems;
  const showSuggestionList =
    (status === 'quick-actions' ||
      ((status === 'user-input' || status === 'user-reviewing') && isPromptFocused)) &&
    currentItems.length > 0;

  const isDisabled = status === 'thinking' || status === 'ai-writing';

  // Do not auto-focus; suggestions should only open after user interaction.
  useEffect(() => {
    inputRef.current?.blur();
    setIsPromptFocused(false);
  }, [anchorPos, status]);

  const getPlaceholder = (): string => {
    if (status === 'thinking') return 'Thinking…';
    if (status === 'ai-writing') return 'Editing…';
    if (status === 'error') return 'Oops! Something went wrong';
    return 'Ask AI anything…';
  };
  const placeholder = getPlaceholder();
  const isPromptEditable = status === 'user-input' || status === 'user-reviewing';
  const promptPlaceholder = isPromptFocused
    ? 'Ask AI what you want...'
    : status === 'user-reviewing'
      ? 'Tell AI what else needs to be changed...'
      : placeholder;

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
        width:
          status === 'quick-actions'
            ? 'auto'
            : (editorRectRef.current?.width ?? (editor.view.dom as HTMLElement).getBoundingClientRect().width),
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
                <div className='mt-2 flex items-center'>{renderSubmitButton('ml-auto')}</div>
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
              className='flex w-full cursor-pointer items-center gap-2.5 rounded-md border-0 bg-transparent px-2 py-1.5 text-left text-[13px] text-text-default-base hover:bg-background-default-secondary'
            >
              <span className='shrink-0 text-text-default-secondary'>{item.icon}</span>
              {item.title}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

export default AIMenu;
