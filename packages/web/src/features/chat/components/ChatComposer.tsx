/**
 * ChatComposer — v13 left-panel chat input box (spec/02 §10.18.5,
 * mockup `2026-04-27-visual-language/05-canvas-native-tailwind.html`
 * line 1853).
 *
 * Three stacked regions inside one bordered shell:
 *
 *   ┌────────────────────────────────────────────────┐
 *   │ [↗]  chip · chip · chip · chip                 │  ← chips row
 *   ├────────────────────────────────────────────────┤
 *   │ free-form textarea …                           │  ← message body
 *   ├────────────────────────────────────────────────┤
 *   │ [⚙ Skill]                            [Send]    │  ← actions row
 *   └────────────────────────────────────────────────┘
 *
 * Per-user, no Yjs. Chat history + composer draft are local React
 * state (memory `project_chat_private_no_yjs`); collaborators don't
 * see each other's chat. The composer doesn't bind to a
 * `Y.XmlFragment` — only the GenerativeNode prompt does (F2-prompt).
 *
 * Send semantics (matches mockup): Cmd/Ctrl + Enter submits; plain
 * Enter / Shift+Enter inserts a newline. Long-form chat reads better
 * with newlines than with auto-submit-on-Enter.
 *
 * Out of scope today (F12): the actual `onSend` integration —
 * ChatComposer is a presentation-only component that surfaces the
 * v13 visual + the chip-row UX so F14 (`整组 land`) can plug it
 * into `AiChatRecordPanel` to replace the per-node `AgentInput`
 * contenteditable pile.
 */
import React, { useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '@/ui/icon';
import { cn } from '@/utils/classnames';

/** Chip kinds we surface today. Mirrors the canvas modalities a user can mention. */
export type ChatChipKind = 'image' | 'video' | 'audio' | 'text' | 'generative';

/**
 * One chip in the composer's reference row. Created when the user
 * picks a node from the canvas via {@link ChatComposerProps.onEnterSelectMode}.
 *
 * Stable `id` is what `onRemoveChip` returns. Chips reference live
 * canvas nodes by `nodeId` — caller decides whether to freeze a
 * snapshot at chip-creation time (per spec §10.13.2 v13's
 * ChipSnapshot contract for GenerativeNode prompts) or to track
 * the live node by id.
 */
export interface ChatChip {
  id: string;
  /** Canvas node id this chip references. */
  nodeId: string;
  /** Modality icon; falls back to `sparkle` when missing. */
  kind: ChatChipKind;
  /** Display name shown in the chip. */
  name: string;
}

/** Icon per chip modality. Single-source so the value is consistent across composer surfaces. */
const ICON_BY_KIND: Record<ChatChipKind, string> = {
  image: 'project-image-icon',
  video: 'project-video-icon',
  audio: 'project-audio-icon',
  text: 'project-text-icon',
  generative: 'base-add',
};

interface ChatComposerProps {
  /** Controlled textarea value. */
  value: string;
  onChange: (next: string) => void;
  /** Chip references the user has picked from the canvas. Empty array = no chips, just a hint. */
  chips: ChatChip[];
  /** Remove one chip; called with the chip's `id`. */
  onRemoveChip?: (chipId: string) => void;
  /**
   * Called when the user clicks the canvas-pick button. The host
   * is expected to switch the canvas into a "click a node to chip
   * it" mode + show an Esc-to-exit affordance (spec §10.18.5).
   */
  onEnterSelectMode?: () => void;
  /** Called on Cmd/Ctrl+Enter submit. Ignored when the textarea is empty / whitespace-only. */
  onSend?: (text: string, chips: ChatChip[]) => void;
  /** Click handler for the Skill picker button. F12 ships a stub; full picker is a follow-up. */
  onPickSkill?: () => void;
  /** Disabled state — e.g. while a previous send is still in flight. */
  disabled?: boolean;
  /** Optional override for the textarea placeholder. */
  placeholder?: string;
  className?: string;
}

const MAX_HEIGHT_PX = 120;
const MIN_HEIGHT_PX = 44;

const ChatComposer: React.FC<ChatComposerProps> = ({
  value,
  onChange,
  chips,
  onRemoveChip,
  onEnterSelectMode,
  onSend,
  onPickSkill,
  disabled = false,
  placeholder,
  className,
}) => {
  const { t } = useTranslation();
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // `/\S/` is the non-whitespace test — `value.trim()` only strips
  // the ends, so a "      \n      " input that looks empty to the
  // user would still survive a `.trim().length > 0` check (the
  // middle `\n` is whitespace but trim doesn't reach it). Sending
  // whitespace-only messages is never the intent.
  const hasContent = /\S/.test(value);
  const canSend = hasContent && !disabled;

  const handleSend = useCallback(() => {
    if (!canSend) return;
    onSend?.(value.trim(), chips);
  }, [canSend, value, chips, onSend]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // Cmd / Ctrl + Enter sends; plain Enter / Shift+Enter inserts
      // a newline (matches the mockup's `e.key === 'Enter' &&
      // !e.shiftKey && (e.metaKey || e.ctrlKey)` rule).
      if (e.key === 'Enter' && !e.shiftKey && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend],
  );

  const computedPlaceholder =
    placeholder ??
    (chips.length > 0
      ? t('canvas.chat.composerPlaceholderWithChips', {
        defaultValue: '描述你想做什么(用 @ 引用上方 chips)…',
      })
      : t('canvas.chat.composerPlaceholder', { defaultValue: '输入消息…' }));

  return (
    <div
      className={cn(
        'rounded-lg border border-border-default-secondary bg-background-default-secondary',
        'focus-within:border-status-selected focus-within:bg-background-default-base',
        'focus-within:ring-2 focus-within:ring-status-selected/15 transition',
        className,
      )}
    >
      {/* Chips row — pick-from-canvas trigger + chip pills + empty-state hint */}
      <div className='flex flex-wrap items-center gap-1 border-b border-border-default-secondary p-1.5 min-h-[36px]'>
        <button
          type='button'
          onClick={onEnterSelectMode}
          title={t('canvas.chat.pickFromCanvas', {
            defaultValue: '从画布选取节点(Esc 退出选择模式)',
          })}
          className='inline-flex h-7 w-7 flex-shrink-0 items-center justify-center rounded text-text-default-secondary hover:bg-background-default-base hover:text-text-default-primary'
        >
          <Icon name='base-add' width={14} height={14} />
        </button>
        {chips.length === 0 ? (
          <span className='px-1.5 text-[10px] font-mono text-text-default-tertiary'>
            {t('canvas.chat.chipsEmptyHint', {
              defaultValue: '点 ← 从画布选取节点添加为引用',
            })}
          </span>
        ) : (
          chips.map((chip) => (
            <div
              key={chip.id}
              className='group relative inline-flex h-6 items-center gap-1 rounded border border-border-default-secondary bg-background-default-base px-2 text-[11px]'
            >
              <Icon
                name={ICON_BY_KIND[chip.kind] ?? 'base-add'}
                width={10}
                height={10}
                className='text-text-default-tertiary'
              />
              <span className='truncate text-text-default-secondary max-w-[80px]'>
                {chip.name}
              </span>
              {onRemoveChip && (
                <button
                  type='button'
                  onClick={() => onRemoveChip(chip.id)}
                  title={t('canvas.chat.removeChip', { defaultValue: '移除' })}
                  className='-mr-1 inline-flex h-4 w-4 items-center justify-center rounded-full bg-text-default-secondary text-white opacity-0 group-hover:opacity-100 hover:bg-background-error-base'
                >
                  <Icon name='base-close-icon' width={8} height={8} color='var(--color-text-on-button-base)' />
                </button>
              )}
            </div>
          ))
        )}
      </div>

      {/* Textarea — controlled, auto-grows up to MAX_HEIGHT_PX */}
      <textarea
        ref={textareaRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={handleKeyDown}
        disabled={disabled}
        placeholder={computedPlaceholder}
        rows={2}
        style={{ minHeight: MIN_HEIGHT_PX, maxHeight: MAX_HEIGHT_PX }}
        className='w-full resize-none border-0 bg-transparent px-3 py-2 text-[13px] leading-relaxed text-text-default-primary outline-none placeholder:text-text-default-tertiary disabled:cursor-not-allowed disabled:opacity-60'
      />

      {/* Footer — Skill picker (stub) + Send */}
      <div className='flex items-center justify-between gap-2 px-2 pb-2'>
        <button
          type='button'
          onClick={onPickSkill}
          title={t('canvas.chat.pickSkill', { defaultValue: '选择 Skill' })}
          className='inline-flex h-7 items-center gap-1 rounded bg-text-default-primary px-2 text-[11px] text-background-default-base hover:bg-text-default-base'
        >
          <Icon name='base-grid' width={12} height={12} />
          <span>{t('canvas.chat.skill', { defaultValue: 'Skill' })}</span>
        </button>
        <button
          type='button'
          aria-label={t('canvas.chat.send', { defaultValue: '发送' })}
          onClick={handleSend}
          disabled={!canSend}
          className={cn(
            'inline-flex h-7 w-8 items-center justify-center rounded transition-colors',
            canSend
              ? 'bg-neutral-900 text-white hover:bg-neutral-700'
              : 'cursor-not-allowed bg-background-neutral-secondary text-text-default-tertiary',
          )}
        >
          <Icon name='project-chat-send-icon' width={14} height={14} color={canSend ? 'var(--color-text-on-button-base)' : 'currentColor'} />
        </button>
      </div>
    </div>
  );
};

export default ChatComposer;
