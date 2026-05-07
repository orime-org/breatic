/**
 * Text node content area: rich-text editing (contentEditable div) + top format toolbar (H1/H2/H3/paragraph/unordered list/ordered list/bold) + bottom action bar (@).
 * Style reference: top toolbar light gray; bottom toolbar consistent with VideoNodeContent.
 */
import React, { memo, useRef, useState, useEffect, forwardRef, useImperativeHandle } from 'react';
import { Icon } from '@/components/base/icon';
import Tooltip from '@/components/base/tooltip';
import { sanitizeRichText } from '@/utils/sanitize';

export interface TextNodeContentHandle {
  focusEditor: () => void;
}

export interface TextNodeContentProps {
  /** Current content (supports HTML or plain text) */
  value: string;
  /** Content change callback (outputs HTML) */
  onChange: (html: string) => void;
  /** Placeholder text */
  placeholder?: string;
  /** Whether the node is selected */
  selected?: boolean;
  /** Whether in editing mode (shows format toolbar and focusable input; otherwise shows preview div, double-click to enter edit) */
  isEditing?: boolean;
  /** Enter edit mode on double-click in preview area */
  onEnterEditMode?: () => void;
  /** @ mention click */
  onMentionClick?: (e: React.MouseEvent) => void;
  /** Callback when blurred with empty content (used to restore initial placeholder state) */
  onBlurWithEmpty?: () => void;
}

const toolbarBarClass = 'flex items-center gap-[2px] rounded-[4px] p-[4px] nodrag bg-background-default-secondary';
const toolbarBtnClass =
  'flex h-[22px] min-w-[22px] px-1.5 items-center justify-center rounded-[4px] text-[#757575] hover:bg-black/5 text-[12px] font-medium';
const formatBtnActiveClass = '!text-[var(--color-text-default-base)]';
const formatBarClass =
  'flex items-center justify-center gap-[2px] rounded-[4px] bg-background-default-secondary p-[4px] nodrag';

/** Consistent with ChatInput: extract plain text from HTML to check if empty */
const getTextFromHtml = (html: string): string => {
  if (!html || !html.trim()) return '';
  const div = document.createElement('div');
  div.innerHTML = html;
  return (div.textContent || div.innerText || '').replace(/\u00A0/g, ' ').trim();
};

/** Move the contentEditable cursor to the end and scroll to bottom to make cursor visible */
const focusAndMoveToEnd = (el: HTMLElement) => {
  el.focus();
  const sel = document.getSelection();
  if (!sel) return;
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  sel.removeAllRanges();
  sel.addRange(range);
  el.scrollTop = el.scrollHeight;
};

const TextNodeContentComponent: React.ForwardRefRenderFunction<TextNodeContentHandle, TextNodeContentProps> = (
  {
    value,
    onChange,
    placeholder = '',
    selected = false,
    isEditing = false,
    onEnterEditMode,
    onMentionClick,
    onBlurWithEmpty,
  },
  ref,
) => {
  const editorRef = useRef<HTMLDivElement>(null);
  const editableAreaRef = useRef<HTMLDivElement>(null);
  const lastEmittedRef = useRef<string>('\u200b'); // Placeholder to ensure value is synced on first mount
  const isEmpty = getTextFromHtml(value).length === 0;
  const [formatState, setFormatState] = useState({ bold: false, block: 'p', orderedList: false, unorderedList: false });

  const updateFormatState = () => {
    const el = editorRef.current;
    const sel = document.getSelection();
    if (!el || !sel || sel.rangeCount === 0 || !sel.anchorNode || !el.contains(sel.anchorNode)) return;
    try {
      const rawBlock = (document.queryCommandValue('formatBlock') || '').toLowerCase();
      const block = rawBlock === 'div' || rawBlock === '' ? 'p' : rawBlock;
      setFormatState({
        bold: document.queryCommandState('bold'),
        block,
        orderedList: document.queryCommandState('insertOrderedList'),
        unorderedList: document.queryCommandState('insertUnorderedList'),
      });
    } catch {
      setFormatState({ bold: false, block: '', orderedList: false, unorderedList: false });
    }
  };

  useEffect(() => {
    const el = editorRef.current;
    if (!el) return;
    const onSelectionChange = () => updateFormatState();
    document.addEventListener('selectionchange', onSelectionChange);
    return () => document.removeEventListener('selectionchange', onSelectionChange);
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      focusEditor: () => editorRef.current?.focus(),
    }),
    [],
  );

  /** Disable Ctrl/Cmd+scroll browser zoom in editing mode only; preview area does not restrict scroll zoom */
  useEffect(() => {
    if (!selected || !isEditing) return;
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) e.preventDefault();
    };
    document.addEventListener('wheel', onWheel, { passive: false, capture: true });
    return () => document.removeEventListener('wheel', onWheel, { capture: true });
  }, [selected, isEditing]);

  /** Sync to editor when external value changes; after writing in editing mode, directly focus and move to end without relying on parent ref call */
  useEffect(() => {
    const el = editorRef.current;
    if (!el) return;
    const elIsEmpty = getTextFromHtml(el.innerHTML).length === 0;
    const valueHasContent = getTextFromHtml(value).length > 0;
    const needSyncFromRemount = elIsEmpty && valueHasContent;
    if (value === lastEmittedRef.current && !needSyncFromRemount) return;
    lastEmittedRef.current = value;
    if (value.trim() === '') {
      el.innerHTML = '';
      return;
    }
    // Always write as HTML so that tags like <b>/<div> are parsed and rendered, not treated as plain text
    el.innerHTML = value;
    if (needSyncFromRemount) {
      requestAnimationFrame(() => focusAndMoveToEnd(el));
    }
  }, [value, isEditing]);

  const emitChange = () => {
    const el = editorRef.current;
    if (!el) return;
    const html = el.innerHTML;
    lastEmittedRef.current = html;
    onChange(html);
  };

  const handleInput = () => {
    emitChange();
  };

  const handleFocus = () => setTimeout(updateFormatState, 0);

  const handleBlur = () => {
    const el = editorRef.current;
    if (!el || !onBlurWithEmpty) return;
    const html = el.innerHTML;
    if (getTextFromHtml(html).length === 0) onBlurWithEmpty();
  };

  const exec = (cmd: string, value?: string) => (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    editorRef.current?.focus();
    (document as Document & { execCommand(c: string, u?: boolean, v?: string): boolean }).execCommand(
      cmd,
      false,
      value,
    );
    emitChange();
    setTimeout(updateFormatState, 0);
  };

  const stopPropagation = (e: React.MouseEvent) => e.stopPropagation();
  /** Editing mode only: stop wheel bubbling (canvas won't pan) and disable Ctrl/Cmd+scroll browser zoom; preview area is unrestricted */
  const handleWheel = (e: React.WheelEvent) => {
    if (!selected || !isEditing) return;
    e.stopPropagation();
    if (e.ctrlKey || e.metaKey) e.preventDefault();
  };

  /** On paste into editor: stop bubbling to prevent canvas "paste creates new node"; insert as HTML if text/html is available or text/plain looks like HTML */
  const handlePaste = (e: React.ClipboardEvent) => {
    e.stopPropagation();
    const html = e.clipboardData.getData('text/html');
    const text = e.clipboardData.getData('text/plain');
    const toInsert = html || (text && text.includes('<') && text.includes('>') ? text : null);
    if (toInsert) {
      e.preventDefault();
      (document as Document & { execCommand(c: string, u?: boolean, v?: string): boolean }).execCommand(
        'insertHTML',
        false,
        sanitizeRichText(toInsert),
      );
      emitChange();
      setTimeout(updateFormatState, 0);
    }
  };

  return (
    <div className='w-full h-full min-h-0 flex flex-col rounded-[8px] overflow-hidden '>
      {/* Top format toolbar: only shown in editing mode */}
      {selected && isEditing && (
        <div className='flex-shrink-0 w-full pb-1 flex justify-center' onMouseDown={stopPropagation}>
          <div className={`${formatBarClass} w-full`}>
            <Tooltip title='H1' placement='top'>
              <button
                type='button'
                className={`${toolbarBtnClass} ${formatState.block === 'h1' ? formatBtnActiveClass : ''}`}
                onMouseDown={exec('formatBlock', 'h1')}
                aria-label='H1'
              >
                <Icon
                  name='project-h1-icon'
                  width={10}
                  height={10}
                  color={formatState.block === 'h1' ? 'var(--color-text-default-base)' : '#757575'}
                />
              </button>
            </Tooltip>
            <Tooltip title='H2' placement='top'>
              <button
                type='button'
                className={`${toolbarBtnClass} ${formatState.block === 'h2' ? formatBtnActiveClass : ''}`}
                onMouseDown={exec('formatBlock', 'h2')}
                aria-label='H2'
              >
                <Icon
                  name='project-h2-icon'
                  width={12}
                  height={12}
                  color={formatState.block === 'h2' ? 'var(--color-text-default-base)' : '#757575'}
                />
              </button>
            </Tooltip>
            <Tooltip title='H3' placement='top'>
              <button
                type='button'
                className={`${toolbarBtnClass} ${formatState.block === 'h3' ? formatBtnActiveClass : ''}`}
                onMouseDown={exec('formatBlock', 'h3')}
                aria-label='H3'
              >
                <Icon
                  name='project-h3-icon'
                  width={12}
                  height={12}
                  color={formatState.block === 'h3' ? 'var(--color-text-default-base)' : '#757575'}
                />
              </button>
            </Tooltip>
            <Tooltip title='Paragraph' placement='top'>
              <button
                type='button'
                className={`${toolbarBtnClass} ${formatState.block === 'p' ? formatBtnActiveClass : ''}`}
                onMouseDown={exec('formatBlock', 'p')}
                aria-label='Paragraph'
              >
                <Icon
                  name='project-paragraph-icon'
                  width={10}
                  height={10}
                  color={formatState.block === 'p' ? 'var(--color-text-default-base)' : '#757575'}
                />
              </button>
            </Tooltip>
            <Tooltip title='Ordered list' placement='top'>
              <button
                type='button'
                className={`${toolbarBtnClass} ${formatState.orderedList ? formatBtnActiveClass : ''}`}
                onMouseDown={exec('insertOrderedList')}
                aria-label='Ordered list'
              >
                <Icon
                  name='project-list-ordered-icon'
                  width={10}
                  height={10}
                  color={formatState.orderedList ? 'var(--color-text-default-base)' : '#757575'}
                />
              </button>
            </Tooltip>
            <Tooltip title='Unordered list' placement='top'>
              <button
                type='button'
                className={`${toolbarBtnClass} ${formatState.unorderedList ? formatBtnActiveClass : ''}`}
                onMouseDown={exec('insertUnorderedList')}
                aria-label='Unordered list'
              >
                <Icon
                  name='project-list-unordered-icon'
                  width={10}
                  height={10}
                  color={formatState.unorderedList ? 'var(--color-text-default-base)' : '#757575'}
                />
              </button>
            </Tooltip>
            <Tooltip title='Bold' placement='top'>
              <button
                type='button'
                className={`${toolbarBtnClass} ${formatState.bold ? formatBtnActiveClass : ''}`}
                onMouseDown={exec('bold')}
                aria-label='Bold'
              >
                <Icon
                  name='project-bold-icon'
                  width={10}
                  height={10}
                  color={formatState.bold ? 'var(--color-text-default-base)' : '#757575'}
                />
              </button>
            </Tooltip>
          </div>
        </div>
      )}

      {/* Content area: contentEditable in editing mode, read-only preview div otherwise; double-click to enter edit mode */}
      <div
        ref={editableAreaRef}
        className={`flex-1 min-h-0 flex flex-col relative overflow-hidden ${selected && isEditing ? 'nowheel nopan' : ''}`}
        {...(selected && isEditing && { 'data-nowheel': true, 'data-nopan': true })}
        onWheel={handleWheel}
        onWheelCapture={handleWheel}
      >
        {!isEditing ? (
          /* Preview: read-only content display; double-click to enter editing when selected; also shows preview when not selected */
          <div
            className='text-node-preview flex-1 min-h-0 w-full overflow-auto text-[14px] text-text-default-base rounded-[4px] cursor-grab py-0 px-0 break-words break-all [&_h1]:text-lg [&_h2]:text-base [&_h3]:text-sm [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5'
            onDoubleClick={(e) => {
              e.stopPropagation();
              onEnterEditMode?.();
            }}
            dangerouslySetInnerHTML={{ __html: sanitizeRichText(value?.trim() || '') }}
          />
        ) : (
          <>
            {placeholder && isEmpty && (
              <div
                className='absolute top-0 inset-0 pb-2 pointer-events-none text-[var(--color-text-default-tertiary)] text-sm leading-relaxed whitespace-pre-wrap'
                aria-hidden
              >
                {placeholder.split('\n').map((line, i) => (
                  <span key={i} className='block'>
                    {line}
                  </span>
                ))}
              </div>
            )}
            <div
              ref={editorRef}
              contentEditable
              className={`text-node-editor flex-1 min-h-0 w-full overflow-auto outline-none text-[14px] text-text-default-base rounded-[4px] nodrag cursor-text break-words break-all ${selected ? 'nowheel nopan' : ''}`}
              {...(selected && { 'data-nowheel': true, 'data-nopan': true })}
              onInput={handleInput}
              onFocus={handleFocus}
              onBlur={handleBlur}
              onPaste={handlePaste}
              onMouseDown={stopPropagation}
              onWheel={handleWheel}
              onWheelCapture={handleWheel}
              suppressContentEditableWarning
            />
          </>
        )}
      </div>

      {/* Bottom action bar: @; only shown when selected and in editing mode */}
      {selected && isEditing && (
        <div className='flex-shrink-0 flex justify-center py-2' onMouseDown={stopPropagation}>
          <div className={toolbarBarClass}>
            <Tooltip title='@' placement='top'>
              <button
                type='button'
                onClick={(e) => {
                  e.stopPropagation();
                  onMentionClick?.(e);
                }}
                className={toolbarBtnClass}
                aria-label='Mention'
              >
                <Icon name='project-chat-mention-icon' width={15} height={15} color='#757575' />
              </button>
            </Tooltip>
          </div>
        </div>
      )}
    </div>
  );
};

const TextNodeContent = memo(forwardRef(TextNodeContentComponent));
export default TextNodeContent;
