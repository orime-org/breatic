import React, { memo, useEffect, useRef, useState } from 'react';
import { useReactFlow, useViewport, type NodeProps } from '@xyflow/react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/ui/button';
import { Icon } from '@/ui/icon';
import Dropdown, { type MenuItemType } from '@/ui/dropdown';

type CommentItem = {
  id: string;
  text: string;
  username: string;
  createdAt: number;
};

type CommentMarkerData = {
  username?: string;
  text?: string;
};

const formatCommentTime = (createdAt: number, t: (key: string, opts?: Record<string, unknown>) => string): string => {
  const diffMs = Date.now() - createdAt;
  if (diffMs < 60 * 1000) return t('canvas.comment.timeJustNow');
  const mins = Math.floor(diffMs / (60 * 1000));
  if (mins < 60) return t('canvas.comment.timeMinutesAgo', { count: mins });
  const hours = Math.floor(mins / 60);
  if (hours < 24) return t('canvas.comment.timeHoursAgo', { count: hours });
  return t('canvas.comment.timeEarlier');
};

/** Lightweight comment marker node shown as a circular avatar chip on canvas. */
const CommentMarkerNode: React.FC<NodeProps> = ({ id, data, selected }) => {
  const { t } = useTranslation();
  const { deleteElements, setNodes } = useReactFlow();
  const { zoom } = useViewport();
  const markerData = (data ?? {}) as CommentMarkerData;
  const username = (markerData.username ?? 'm').trim() || 'm';
  const content = (markerData.text ?? '').trim();
  const maxChars = 200;
  const [reply, setReply] = useState('');
  const [editingCommentId, setEditingCommentId] = useState<string | null>(null);
  const [editingValue, setEditingValue] = useState('');
  const [hoveringPanel, setHoveringPanel] = useState(false);
  const [openedMenuCommentId, setOpenedMenuCommentId] = useState<string | null>(null);
  const canSend = reply.trim().length > 0;
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const inlineEditRef = useRef<HTMLTextAreaElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [panelFocused, setPanelFocused] = useState(false);
  const [comments, setComments] = useState<CommentItem[]>(
    content ? [{ id: 'initial', text: content, username, createdAt: Date.now() - 2 * 60 * 1000 }] : [],
  );
  const handleSendReply = () => {
    const next = reply.trim();
    if (!next) return;
    setComments((prev) => [
      ...prev,
      { id: `comment-${Date.now()}`, text: next, username: '我', createdAt: Date.now() },
    ]);
    setReply('');
    textareaRef.current?.blur();
    setTimeout(() => {
      const listEl = listRef.current;
      if (!listEl) return;
      listEl.scrollTop = listEl.scrollHeight;
    }, 0);
  };

  const handleStartEdit = (commentId: string) => {
    const target = comments.find((item) => item.id === commentId);
    if (!target) return;
    setEditingCommentId(commentId);
    setEditingValue(target.text);
    setTimeout(() => {
      const input = inlineEditRef.current;
      if (!input) return;
      input.focus();
      const end = input.value.length;
      input.setSelectionRange(end, end);
    }, 0);
  };

  /** Blurs the currently focused element if it lives inside the floating panel (textarea or Save/Cancel). */
  const blurFocusInsidePanel = () => {
    const root = panelRef.current;
    if (!root) return;
    const active = document.activeElement;
    if (active instanceof HTMLElement && root.contains(active)) {
      active.blur();
    }
  };

  const handleCommitEdit = (commentId: string) => {
    const next = editingValue.trim();
    if (!next) {
      setEditingCommentId(null);
      setEditingValue('');
      blurFocusInsidePanel();
      return;
    }
    setComments((prev) => prev.map((item) => (item.id === commentId ? { ...item, text: next } : item)));
    setEditingCommentId(null);
    setEditingValue('');
    blurFocusInsidePanel();
  };

  const handleCancelEdit = () => {
    setEditingCommentId(null);
    setEditingValue('');
    blurFocusInsidePanel();
  };

  const handlePanelMouseLeave = () => {
    setHoveringPanel(false);
    setOpenedMenuCommentId(null);
  };

  const handleInlineEditKeyDown = (commentId: string, event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      handleCancelEdit();
    }
  };

  const handleCommentMenuClick = (actionKey: string, commentId: string) => {
    if (actionKey === `edit-${commentId}`) {
      handleStartEdit(commentId);
      return;
    }
    if (actionKey === `delete-${commentId}`) {
      setComments((prev) => prev.filter((item) => item.id !== commentId));
      if (editingCommentId === commentId) {
        handleCancelEdit();
      }
    }
  };

  const handleMenuOpenChange = (commentId: string, open: boolean) => {
    setOpenedMenuCommentId((prev) => {
      if (open) return commentId;
      return prev === commentId ? null : prev;
    });
  };

  const getCommentMenuItems = (commentId: string): MenuItemType[] => [
    {
      key: `edit-${commentId}`,
      label: (
        <div className='flex items-center text-xs text-text-default-base'>
          <Icon
            name='project-comment-edit-icon'
            width={12}
            height={12}
            className='mr-2'
            color='var(--color-text-default-base)'
          />
          编辑
        </div>
      ),
    },
    {
      key: `delete-${commentId}`,
      label: (
        <div className='flex items-center text-xs text-text-default-base'>
          <Icon
            name='project-comment-delete-icon'
            width={12}
            height={12}
            className='mr-2'
            color='var(--color-text-default-base)'
          />
          删除
        </div>
      ),
    },
  ];

  useEffect(() => {
    if (comments.length > 0) return;
    void deleteElements({ nodes: [{ id }] });
  }, [comments.length, deleteElements, id]);

  useEffect(() => {
    setNodes((nodes) => {
      let changed = false;
      const nextNodes = nodes.map((node) => {
        if (node.id !== id || node.selectable === false) return node;
        changed = true;
        return { ...node, selectable: false };
      });
      return changed ? nextNodes : nodes;
    });
  }, [id, setNodes]);

  const panelVisible = hoveringPanel || openedMenuCommentId !== null || panelFocused;
  useEffect(() => {
    if (panelVisible) return;
    if (editingCommentId !== null) {
      setEditingCommentId(null);
      setEditingValue('');
    }
    if (openedMenuCommentId !== null) {
      setOpenedMenuCommentId(null);
    }
  }, [panelVisible, editingCommentId, openedMenuCommentId]);

  if (comments.length === 0) {
    return null;
  }

  return (
    <div
      className='relative overflow-visible'
      onMouseEnter={() => setHoveringPanel(true)}
      onMouseLeave={handlePanelMouseLeave}
      style={{
        transform: `scale(${zoom > 0 ? 1 / zoom : 1})`,
        transformOrigin: 'top left',
      }}
    >
      <div
        className={
          `pointer-events-auto inline-flex h-8 w-8 select-none items-center justify-center rounded-full border-2 text-center text-sm font-bold leading-none text-white shadow-md transition-opacity duration-150 ${
            panelVisible ? 'opacity-0' : ''
          } ` +
          (selected ? 'border-[var(--color-border-utilities-selected)] bg-brand-base' : 'border-brand-base bg-brand-base')
        }
      >
        <span className='block leading-none'>{username}</span>
      </div>
      <div
        ref={panelRef}
        className={`absolute left-0 top-0 z-20 w-[430px] rounded-[12px] border border-border-default-base bg-background-default-base shadow-[0_8px_24px_rgba(0,0,0,0.18)] transition-opacity duration-150 ${
          panelVisible ? 'pointer-events-auto visible opacity-100' : 'pointer-events-none invisible opacity-0'
        }`}
        onMouseEnter={() => setHoveringPanel(true)}
        onMouseLeave={handlePanelMouseLeave}
        onFocusCapture={() => {
          setPanelFocused(true);
        }}
        onBlurCapture={(event) => {
          const nextTarget = event.relatedTarget as Node | null;
          if (nextTarget && panelRef.current?.contains(nextTarget)) return;
          setPanelFocused(false);
        }}
        onWheelCapture={(event) => {
          event.stopPropagation();
        }}
      >
        <div
          ref={listRef}
          className='max-h-[220px] overflow-y-auto'
          onWheelCapture={(event) => {
            event.stopPropagation();
          }}
        >
          {comments.map((item, index) => (
            <div key={item.id} className={index === 0 ? '' : 'border-t border-border-default-base'}>
              <div className='rounded-[6px] px-3 py-2'>
                <div className='mb-1 flex items-center justify-between'>
                  <div className='flex min-w-0 items-center gap-2'>
                    <span className='inline-flex h-7 w-7 items-center justify-center rounded-full bg-brand-base text-xs font-semibold text-white'>
                      {item.username.slice(0, 1)}
                    </span>
                    <div className='flex min-w-0 items-center gap-1'>
                      <span className='truncate text-[14px] font-semibold text-text-default-base'>{item.username}</span>
                      <span className='shrink-0 text-xs text-text-default-tertiary'>
                        {formatCommentTime(item.createdAt, t)}
                      </span>
                    </div>
                  </div>
                  <Dropdown
                    trigger='click'
                    placement='bottom-end'
                    offset={6}
                    popupClassName='min-w-[120px] rounded-[8px] p-1'
                    onOpenChange={(open) => handleMenuOpenChange(item.id, open)}
                    items={getCommentMenuItems(item.id)}
                    onClick={(key) => handleCommentMenuClick(key, item.id)}
                  >
                    <button
                      type='button'
                      className='inline-flex h-6 w-6 items-center justify-center rounded-full hover:bg-background-default-secondary'
                    >
                      <Icon name='project-comment-more-icon' width={14} height={14} color='var(--color-icon-base)' />
                    </button>
                  </Dropdown>
                </div>
                {editingCommentId === item.id ? (
                  <div className='pl-8'>
                    <div className='overflow-hidden rounded-[8px] bg-background-default-secondary'>
                      <textarea
                        ref={inlineEditRef}
                        rows={2}
                        value={editingValue}
                        maxLength={maxChars}
                        onChange={(event) => setEditingValue(event.target.value)}
                        onKeyDown={(event) => handleInlineEditKeyDown(item.id, event)}
                        className='w-full resize-none border-none bg-transparent px-2 py-1 text-[12px] leading-5 text-text-default-base outline-none'
                      />
                      <div className='flex items-center justify-end gap-2 border-t border-[#0000001A] px-2 py-2'>
                        <button
                          type='button'
                          onClick={handleCancelEdit}
                          className='h-7 rounded-[6px] border border-[#0000001A] px-3 text-xs text-text-default-base hover:bg-background-default-secondary'
                        >
                          Cancel
                        </button>
                        <button
                          type='button'
                          onClick={() => handleCommitEdit(item.id)}
                          disabled={editingValue.trim().length === 0}
                          className='h-7 rounded-[6px] bg-brand-base px-3 text-xs font-semibold text-white hover:bg-brand-600 disabled:cursor-not-allowed disabled:bg-background-neutral-secondary'
                        >
                          Save
                        </button>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className='pl-8 whitespace-pre-wrap break-words text-[12px] leading-5 text-text-default-base'>
                    {item.text}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
        <div className='border-t border-border-default-base p-[12px]'>
          <div className='relative rounded-[8px] border-none bg-background-default-secondary px-2 py-1.5'>
            <textarea
              ref={textareaRef}
              rows={2}
              value={reply}
              maxLength={maxChars}
              onChange={(event) => setReply(event.target.value)}
              onWheelCapture={(event) => {
                event.stopPropagation();
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  handleSendReply();
                }
              }}
              placeholder={t('canvas.comment.replyPlaceholder')}
              className='h-[96px] w-full resize-none border-none bg-transparent px-0 pt-0 text-[13px] text-text-default-base outline-none placeholder:text-text-default-tertiary'
            />
            <div className='pointer-events-auto absolute bottom-[6px] right-[2px] flex items-center gap-2 pr-2'>
              <span className='text-[12px] font-semibold text-text-default-tertiary'>
                {reply.length}/{maxChars}
              </span>
              <Button
                type='primary'
                size='medium'
                shape='round'
                disabled={!canSend}
                onClick={handleSendReply}
                icon={<Icon name='project-chat-send-icon' width={18} height={16} color='var(--color-text-on-button-base)' />}
                className='!h-[28px] w-[52px] shrink-0 !border-brand-base !bg-brand-base !py-[2px] !pl-[16px] !pr-[12px] hover:!border-brand-base hover:!bg-brand-base disabled:!border-background-neutral-secondary disabled:!bg-background-neutral-secondary'
                aria-label={t('canvas.comment.send')}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default memo(CommentMarkerNode);
