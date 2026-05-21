import { ArrowUp, Square, SquareMousePointer, Wand2 } from 'lucide-react';
import * as React from 'react';

interface ReferenceChip {
  id: string;
  label: string;
  type?: string;
}

interface ChatComposerProps {
  draft: string;
  streaming?: boolean;
  chips?: ReadonlyArray<ReferenceChip>;
  activeSkillLabel?: string;
  selectMode?: boolean;
  onChange: (next: string) => void;
  onSubmit: () => void;
  onAbort?: () => void;
  onToggleSelectMode?: () => void;
  onPickSkill?: () => void;
  onRemoveChip?: (id: string) => void;
}

/**
 * Bottom-of-panel chat composer — single outer container, 3 stacked
 * sections sharing one border + focus-within (mirrors mock `.composer`
 * lines 627-758):
 *
 *   ┌───────────────────────────────────┐
 *   │ [📐 select mode] [chip] [chip]…   │  ← composer-top (24px row)
 *   │ ─────────────────────────────────── │  ← chips/input divider
 *   │ describe what you want…              │  ← composer-input (rows=3)
 *   │ ─────────────────────────────────── │
 *   │ [✨ Skill]                  [↑]    │  ← composer-actions
 *   └───────────────────────────────────┘
 *
 * Enter submits, Shift+Enter inserts a newline. While streaming, the
 * send button swaps to an Abort (Square) icon so users can stop runaway
 * responses. Send button has 3 visual states:
 *   - disabled:   empty draft, muted gray
 *   - ready:      has text, solid foreground bg + background text
 *   - streaming:  destructive accent
 */
export function ChatComposer({
  draft,
  streaming,
  chips = [],
  activeSkillLabel,
  selectMode,
  onChange,
  onSubmit,
  onAbort,
  onToggleSelectMode,
  onPickSkill,
  onRemoveChip,
}: ChatComposerProps) {
  const ready = draft.trim().length > 0 && !streaming;

  const submit = () => {
    if (!ready) return;
    onSubmit();
  };

  return (
    <div className='p-2'>
      <div
        data-testid='chat-composer'
        className='flex flex-col rounded-chrome border border-border bg-background transition-colors focus-within:border-muted-foreground'
      >
        <div className='flex min-h-[28px] items-center gap-2 px-2 py-1'>
          <button
            type='button'
            aria-label='选中模式 — 在画布点节点添加引用'
            title='选中模式'
            onClick={onToggleSelectMode}
            data-testid='chat-composer-select-mode'
            aria-pressed={selectMode}
            className={`inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-[4px] transition-colors hover:bg-muted ${
              selectMode
                ? 'bg-muted text-foreground'
                : 'text-muted-foreground'
            }`}
          >
            <SquareMousePointer className='h-4 w-4' />
          </button>
          <div
            className='flex min-w-0 flex-1 flex-wrap items-center gap-1'
            data-testid='chat-composer-chips'
            role='list'
            aria-label='已选 chips'
          >
            {chips.map((chip) => (
              <span
                key={chip.id}
                role='listitem'
                className='inline-flex h-5 items-center gap-1 rounded-[4px] bg-muted px-1.5 text-[11px] text-foreground'
                data-testid={`chat-chip-${chip.id}`}
              >
                {chip.type ? (
                  <span className='text-muted-foreground'>{chip.type}</span>
                ) : null}
                <span className='truncate'>{chip.label}</span>
                {onRemoveChip ? (
                  <button
                    type='button'
                    aria-label={`Remove ${chip.label}`}
                    onClick={() => onRemoveChip(chip.id)}
                    className='ml-0.5 inline-flex h-3 w-3 items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground'
                  >
                    ×
                  </button>
                ) : null}
              </span>
            ))}
          </div>
        </div>
        <div className='border-t border-border' />
        <textarea
          value={draft}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder='描述你想做什么(用 @ 引用上方 chips)…'
          rows={3}
          className='block w-full resize-none border-0 bg-transparent px-3 py-2 text-[13px] leading-relaxed text-foreground outline-none placeholder:text-muted-foreground'
          aria-label='Chat 输入'
          data-testid='chat-composer-textarea'
        />
        <div className='flex items-center justify-between border-t border-border px-2 py-1'>
          <button
            type='button'
            aria-label='选择 Skill 限定 agent 行为'
            title='选择 Skill'
            onClick={onPickSkill}
            data-testid='chat-composer-skill'
            className={`inline-flex h-7 items-center gap-1.5 rounded-[4px] px-2 text-[12px] transition-colors hover:bg-muted ${
              activeSkillLabel
                ? 'text-foreground'
                : 'text-muted-foreground'
            }`}
          >
            <Wand2 className='h-4 w-4' />
            <span>{activeSkillLabel ?? 'Skill'}</span>
          </button>
          {streaming ? (
            <button
              type='button'
              aria-label='Abort'
              onClick={onAbort}
              data-testid='chat-composer-abort'
              className='inline-flex h-7 w-7 items-center justify-center rounded-[4px] bg-destructive text-destructive-foreground transition-opacity hover:opacity-90'
            >
              <Square className='h-4 w-4' />
            </button>
          ) : (
            <button
              type='button'
              aria-label='发送'
              title='发送'
              disabled={!ready}
              onClick={submit}
              data-testid='chat-composer-send'
              className={`inline-flex h-7 w-7 items-center justify-center rounded-[4px] transition-opacity disabled:cursor-not-allowed ${
                ready
                  ? 'bg-foreground text-background hover:opacity-90'
                  : 'bg-muted text-muted-foreground'
              }`}
            >
              <ArrowUp className='h-4 w-4' />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export type { ReferenceChip };
