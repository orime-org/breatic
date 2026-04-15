import {
  KeyboardEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { autoUpdate, offset, shift, useFloating } from '@floating-ui/react';
import type { Editor } from '@tiptap/react';
import {
  RiArrowGoBackFill,
  RiCheckFill,
  RiCheckLine,
  RiEarthLine,
  RiLoopLeftFill,
  RiMagicLine,
  RiSparkling2Fill,
  RiText,
} from 'react-icons/ri';
import { cn } from '@/utils/classnames';
import { AiErrorIcon, AiSpinnerIcon } from './TextEditorIcons';

// ── Types ────────────────────────────────────────────────────────────────────

type AIStatus = 'user-input' | 'thinking' | 'ai-writing' | 'user-reviewing' | 'error';

interface AISuggestionItem {
  key: string;
  title: string;
  icon: React.ReactNode;
  onClick: () => void;
}

export interface AIMenuProps {
  editor: Editor;
  anchorPos: number;
  onClose: () => void;
}

// ── Main component ────────────────────────────────────────────────────────────

const AIMenu = ({ editor, anchorPos, onClose }: AIMenuProps) => {
  const [status, setStatus] = useState<AIStatus>('user-input');
  const [prompt, setPrompt] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const editorRectRef = useRef<DOMRect | null>(null);

  const { refs, floatingStyles, update } = useFloating({
    open: true,
    placement: 'bottom-start',
    strategy: 'fixed',
    middleware: [offset(8), shift({ padding: 8 })],
    whileElementsMounted: autoUpdate,
  });

  const reference = useMemo(() => {
    const editorDom = editor.view.dom as HTMLElement;
    return {
      contextElement: editorDom,
      getBoundingClientRect: () => {
        const coords = editor.view.coordsAtPos(anchorPos);
        const editorRect = editorDom.getBoundingClientRect();
        editorRectRef.current = editorRect;
        return {
          x: editorRect.left,
          y: coords.bottom,
          width: editorRect.width,
          height: 1,
          top: coords.bottom,
          left: editorRect.left,
          right: editorRect.left + editorRect.width,
          bottom: coords.bottom + 1,
        };
      },
    };
  }, [editor, anchorPos]);

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

  // Close on click outside
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (menuRef.current?.contains(e.target as Node)) return;
      onClose();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);

  // Simulate AI thinking → writing → reviewing (static demo)
  const simulateAI = useCallback(() => {
    setStatus('thinking');
    const t1 = setTimeout(() => {
      setStatus('ai-writing');
      const t2 = setTimeout(() => setStatus('user-reviewing'), 800);
      return () => clearTimeout(t2);
    }, 1200);
    return () => clearTimeout(t1);
  }, []);

  const handleSuggestionClick = (item: AISuggestionItem) => {
    item.onClick();
    simulateAI();
  };

  const handleSubmit = useCallback(() => {
    if (!prompt.trim()) return;
    simulateAI();
  }, [prompt, simulateAI]);

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      handleSubmit();
    } else if (e.key === 'Escape') {
      onClose();
    }
  };

  // ── Suggestion items based on status ────────────────────────────────────

  const withSelectionItems: AISuggestionItem[] = [
    {
      key: 'improve',
      title: 'Improve writing',
      icon: <RiText size={16} />,
      onClick: () => {},
    },
    {
      key: 'spelling',
      title: 'Fix spelling',
      icon: <RiCheckLine size={16} />,
      onClick: () => {},
    },
    {
      key: 'translate',
      title: 'Translate…',
      icon: <RiEarthLine size={16} />,
      onClick: () => {},
    },
    {
      key: 'simplify',
      title: 'Simplify',
      icon: <RiMagicLine size={16} />,
      onClick: () => {},
    },
  ];

  const reviewItems: AISuggestionItem[] = [
    {
      key: 'accept',
      title: 'Accept',
      icon: <RiCheckFill size={16} />,
      onClick: onClose,
    },
    {
      key: 'revert',
      title: 'Revert',
      icon: <RiArrowGoBackFill size={16} />,
      onClick: onClose,
    },
  ];

  const errorItems: AISuggestionItem[] = [
    {
      key: 'retry',
      title: 'Retry',
      icon: <RiLoopLeftFill size={16} />,
      onClick: () => simulateAI(),
    },
    {
      key: 'cancel',
      title: 'Cancel',
      icon: <RiArrowGoBackFill size={16} />,
      onClick: onClose,
    },
  ];

  const getCurrentItems = (): AISuggestionItem[] => {
    if (status === 'user-input') return withSelectionItems;
    if (status === 'user-reviewing') return reviewItems;
    if (status === 'error') return errorItems;
    return [];
  };
  const currentItems: AISuggestionItem[] = getCurrentItems();

  const isDisabled = status === 'thinking' || status === 'ai-writing';

  const getPlaceholder = (): string => {
    if (status === 'thinking') return 'Thinking…';
    if (status === 'ai-writing') return 'Editing…';
    if (status === 'error') return 'Oops! Something went wrong';
    return 'Ask AI anything…';
  };
  const placeholder = getPlaceholder();

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
      className='flex flex-col gap-1 outline-none'
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
          {currentItems.map((item) => (
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
