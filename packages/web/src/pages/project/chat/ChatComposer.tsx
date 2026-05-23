import { ArrowUp, Square, SquareMousePointer, Wand2 } from 'lucide-react';
import * as React from 'react';

import { useTranslation } from '@/i18n/use-translation';

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
 * sections sharing one border + focus-within. Sizing + colour match
 * chrome-baseline mock `.composer` (finalized.html lines 627-758) so
 * the elevated card visually sits on top of the panel surface.
 *
 *   ┌───────────────────────────────────┐  bg = --neutral-50 (elevated)
 *   │ [📐 select mode] [chip] [chip]…   │  composer-top   p 8/16, min-h 32
 *   │ ─────────────────────────────────── │  chips/input divider
 *   │ describe what you want…            │  composer-input p 10/12/4
 *   │ ─────────────────────────────────── │
 *   │ [✨ Skill]                  [↑]    │  composer-actions p 12/16/16
 *   └───────────────────────────────────┘  radius = --radius-content-md (12px)
 *
 * Visual tokens (mock-aligned, see CSS lines 627-758):
 *   - Outer card uses `bg-muted` (closest semantic to mock's
 *     `--neutral-50` elevated step; ADR 14 brand-guard forbids raw
 *     `bg-neutral-*` in chrome surfaces)
 *   - Outer radius is `rounded-md` (= `--radius-content-md` 12px,
 *     Tweaks-linked so the slider can resize content-region radius)
 *   - Focus-within border uses `border-muted-foreground` (closest
 *     semantic to mock's `--neutral-700` darken on focus)
 *   - Select-mode toggle and send button use the same 32 / 28 px hit
 *     areas as the mock (`--btn-chrome` and `--btn-inline`)
 *
 * Behaviour:
 *   - Enter without Shift submits; Shift+Enter newlines
 *   - Send button has 3 visual states: disabled (empty draft),
 *     ready (foreground/background swap), streaming (destructive
 *     accent → Abort with Square icon)
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
  const t = useTranslation();
  const ready = draft.trim().length > 0 && !streaming;

  const submit = () => {
    if (!ready) return;
    onSubmit();
  };

  return (
    <div
      data-testid='chat-composer'
      className='m-2.5 flex flex-col overflow-hidden rounded-md border border-border bg-elevated transition-colors focus-within:border-active-border'
    >
      <div className='flex min-h-[var(--btn-chrome)] flex-nowrap items-center gap-1.5 border-b border-border px-2 py-1'>
        <button
          type='button'
          aria-label={t('chat.composer.selectMode.label')}
          title={t('chat.composer.selectMode.title')}
          onClick={onToggleSelectMode}
          data-testid='chat-composer-select-mode'
          aria-pressed={selectMode}
          className={`inline-flex h-[var(--btn-chrome)] w-[var(--btn-chrome)] shrink-0 items-center justify-center rounded-chrome transition-colors ${
            selectMode
              ? 'bg-foreground text-background'
              : 'bg-transparent text-muted-foreground hover:bg-muted hover:text-foreground'
          }`}
        >
          <SquareMousePointer className='h-4 w-4' />
        </button>
        <div
          className='flex min-w-0 flex-1 flex-wrap items-center gap-1 py-0.5'
          data-testid='chat-composer-chips'
          role='list'
          aria-label={t('chat.composer.chipsAria')}
        >
          {chips.map((chip) => (
            <span
              key={chip.id}
              role='listitem'
              className='inline-flex h-6 items-center gap-1 rounded-chrome border border-border bg-muted pl-2 pr-1 text-[12px] text-foreground'
              data-testid={`chat-chip-${chip.id}`}
            >
              {chip.type ? (
                <span className='text-[11px] text-muted-foreground'>
                  {chip.type}
                </span>
              ) : null}
              <span className='truncate'>{chip.label}</span>
              {onRemoveChip ? (
                <button
                  type='button'
                  aria-label={`Remove ${chip.label}`}
                  onClick={() => onRemoveChip(chip.id)}
                  className='inline-flex h-4 w-4 items-center justify-center rounded-[4px] text-[12px] leading-none text-muted-foreground hover:bg-accent hover:text-foreground'
                >
                  ×
                </button>
              ) : null}
            </span>
          ))}
        </div>
      </div>
      <textarea
        value={draft}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
        }}
        placeholder={t('chat.composer.placeholder')}
        rows={3}
        className='block max-h-[200px] min-h-[72px] w-full resize-none border-0 bg-transparent px-3 pb-1 pt-2.5 text-[13px] leading-normal text-foreground outline-none placeholder:text-muted-foreground'
        aria-label={t('chat.composer.inputAria')}
        data-testid='chat-composer-textarea'
      />
      <div className='flex items-center justify-between gap-2 px-2 pb-2 pt-1.5'>
        <button
          type='button'
          aria-label={t('chat.composer.skill.label')}
          title={t('chat.composer.skill.title')}
          onClick={onPickSkill}
          data-testid='chat-composer-skill'
          className={`inline-flex h-[var(--btn-inline)] items-center gap-1.5 rounded-chrome border border-transparent px-2 text-[12px] font-medium transition-colors ${
            activeSkillLabel
              ? 'border-foreground bg-foreground text-background'
              : 'bg-transparent text-muted-foreground hover:bg-muted hover:text-foreground'
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
            className='inline-flex h-[var(--btn-inline)] w-[var(--btn-inline)] shrink-0 items-center justify-center rounded-chrome bg-destructive text-destructive-foreground transition-opacity hover:opacity-90'
          >
            <Square className='h-4 w-4' />
          </button>
        ) : (
          <button
            type='button'
            aria-label={t('chat.composer.send')}
            title={t('chat.composer.send')}
            disabled={!ready}
            onClick={submit}
            data-testid='chat-composer-send'
            className={`inline-flex h-[var(--btn-inline)] w-[var(--btn-inline)] shrink-0 items-center justify-center rounded-chrome transition-opacity disabled:cursor-not-allowed ${
              ready
                ? 'bg-foreground text-background transition-colors hover:bg-primary-hover'
                : 'bg-muted text-muted-foreground hover:bg-accent hover:text-foreground'
            }`}
          >
            <ArrowUp className='h-4 w-4' />
          </button>
        )}
      </div>
    </div>
  );
}

export type { ReferenceChip };
