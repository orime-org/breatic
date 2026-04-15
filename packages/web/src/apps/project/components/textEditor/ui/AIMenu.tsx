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
import {
  RiArrowGoBackFill,
  RiCheckFill,
  RiEdit2Line,
  RiFileTextLine,
  RiListCheck2,
  RiLoopLeftFill,
  RiMagicLine,
  RiSparkling2Fill,
  RiTranslate2,
  RiExpandLeftRightLine,
} from 'react-icons/ri';
import { cn } from '@/utils/classnames';
import { AiErrorIcon, AiSpinnerIcon } from './TextEditorIcons';

// ── Types ────────────────────────────────────────────────────────────────────

type AIStatus = 'user-input' | 'thinking' | 'ai-writing' | 'user-reviewing' | 'error';

interface AISuggestionItem {
  key: string;
  title: string;
  icon: ReactNode;
  onClick: () => void;
}

export interface AIMenuProps {
  editor: Editor;
  anchorPos: number;
  onClose: () => void;
  menuVariant?: 'selection' | 'generation';
  onPreviewApplied?: () => void;
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

const AIMenu = ({ editor, anchorPos, onClose, menuVariant = 'selection', onPreviewApplied }: AIMenuProps) => {
  const [status, setStatus] = useState<AIStatus>('user-input');
  const [prompt, setPrompt] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const editorRectRef = useRef<DOMRect | null>(null);
  const timersRef = useRef<number[]>([]);
  const previewRef = useRef<{ from: number; to: number; originalText: string } | null>(null);

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
  }, [editor, anchorPos, placement]);

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

  // Auto-focus input when menu opens
  useEffect(() => {
    const id = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, []);

  const clearTimers = useCallback(() => {
    for (const id of timersRef.current) window.clearTimeout(id);
    timersRef.current = [];
  }, []);

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
      onClose();
    },
    [clearTimers, onClose, revertPreview],
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
      const { from, to } = editor.state.selection;
      const originalText = editor.state.doc.textBetween(from, to, '\n', '\n');
      editor
        .chain()
        .focus()
        .insertContentAt({ from, to }, replacement)
        .setTextSelection({ from, to: from + replacement.length })
        .setColor(previewColor)
        .setTextSelection(from + replacement.length)
        // Clear stored color mark so subsequent typing stays default-colored.
        .unsetColor()
        .run();
      previewRef.current = { from, to: from + replacement.length, originalText };
      onPreviewApplied?.();
      return true;
    },
    [editor, onPreviewApplied],
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

  // Close on click outside
  useEffect(() => {
    const handler = (e: MouseEvent) => {
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

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      handleSubmit();
    } else if (e.key === 'Escape') {
      closeMenu();
    }
  };

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
      icon: <RiExpandLeftRightLine size={16} />,
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
      icon: <RiFileTextLine size={16} />,
      onClick: () => runPreviewFlow('[CONTINUE] This is fixed replacement content.'),
    },
  ];

  const generationItems: AISuggestionItem[] = [
    {
      key: 'generate',
      title: 'generate',
      icon: <RiMagicLine size={16} />,
      onClick: () => runPreviewFlow('[GENERATE] This is fixed replacement content.'),
    },
    {
      key: 'character',
      title: 'character',
      icon: <RiEdit2Line size={16} />,
      onClick: () => runPreviewFlow('[CHARACTER] This is fixed replacement content.'),
    },
    {
      key: 'storyboard',
      title: 'storyboard',
      icon: <RiListCheck2 size={16} />,
      onClick: () => runPreviewFlow('[STORYBOARD] This is fixed replacement content.'),
    },
    {
      key: 'script',
      title: 'script',
      icon: <RiFileTextLine size={16} />,
      onClick: () => runPreviewFlow('[SCRIPT] This is fixed replacement content.'),
    },
  ];

  const reviewItems: AISuggestionItem[] = [
    {
      key: 'accept',
      title: 'Accept',
      icon: <RiCheckFill size={16} />,
      onClick: acceptPreview,
    },
    {
      key: 'revert',
      title: 'Revert',
      icon: <RiArrowGoBackFill size={16} />,
      onClick: () => closeMenu(),
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
    if (status === 'user-input') return menuVariant === 'generation' ? generationItems : selectionItems;
    if (status === 'user-reviewing') return reviewItems;
    if (status === 'error') return errorItems;
    return [];
  };
  const currentItems: AISuggestionItem[] = getCurrentItems();
  const renderedItems: AISuggestionItem[] = menuPlacedOnTop ? [...currentItems].reverse() : currentItems;

  const isDisabled = status === 'thinking' || status === 'ai-writing';

  const getPlaceholder = (): string => {
    if (status === 'thinking') return 'Thinking…';
    if (status === 'ai-writing') return 'Editing…';
    if (status === 'error') return 'Oops! Something went wrong';
    return 'Ask AI anything…';
  };
  const placeholder = getPlaceholder();

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
      style={{
        ...floatingStyles,
        width: editorRectRef.current?.width ?? (editor.view.dom as HTMLElement).getBoundingClientRect().width,
        zIndex: 88,
      }}
      className={cn('flex gap-1 outline-none', menuPlacedOnTop ? 'flex-col-reverse' : 'flex-col')}
    >
      {/* Prompt input area */}
      <div
        className={cn(
          'flex items-center gap-2 rounded-[8px] border border-border-default-base bg-background-default-base px-3',
          'shadow-[0px_1px_4px_0px_rgba(12,12,13,0.05),0px_8px_24px_rgba(12,12,13,0.12)]',
        )}
        style={{ minHeight: 40 }}
      >
        {/* Left icon */}
        <span className='shrink-0 text-brand-base'>
          <RiSparkling2Fill size={16} />
        </span>

        {/* Input */}
        <input
          ref={inputRef}
          className='flex-1 bg-transparent py-2 text-[14px] text-text-default-base outline-none placeholder:text-text-default-tertiary disabled:pointer-events-none'
          placeholder={placeholder}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={isDisabled}
          autoComplete='off'
          aria-label='AI prompt'
        />

        {/* Right section: spinner or error */}
        {isDisabled && (
          <span className='shrink-0 text-text-default-tertiary'>
            <AiSpinnerIcon size={14} className='animate-spin' />
          </span>
        )}
        {status === 'error' && (
          <span className='shrink-0 text-red-500'>
            <AiErrorIcon size={16} />
          </span>
        )}
      </div>

      {/* Suggestion list */}
      {currentItems.length > 0 && (
        <div
          className={cn(
            'overflow-hidden rounded-[8px] border border-border-default-base bg-background-default-base py-1',
            'shadow-[0px_1px_4px_0px_rgba(12,12,13,0.05),0px_8px_24px_rgba(12,12,13,0.12)]',
          )}
        >
          {renderedItems.map((item) => (
            <button
              key={item.key}
              type='button'
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => handleSuggestionClick(item)}
              className='flex w-full cursor-pointer items-center gap-2.5 border-0 px-3 py-1.5 text-left text-[13px] text-text-default-base hover:bg-background-default-secondary'
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
