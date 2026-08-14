// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { ArrowUp, Loader2, Square, SquareMousePointer, Wand2 } from 'lucide-react';
import * as React from 'react';

import { Button } from '@web/components/ui/button';
import { useTranslation } from '@web/i18n/use-translation';
import type { TurnPhase } from '@web/stores/conversation-runtime';

interface ReferenceChip {
  id: string;
  label: string;
  type?: string;
}

interface ChatComposerProps {
  draft: string;
  /**
   * How far along the turn is, which decides what stands where Send does.
   *
   * `sending` is the wait between the press and the server's first word.
   * Neither button belongs there: sending again would ask the same thing
   * twice, and a stop button would offer to stop something this end has no
   * word of yet -- with nothing on screen for stopping it to take back.
   */
  turnPhase?: TurnPhase;
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
 * chrome-baseline mock `.composer` so the elevated card visually sits
 * on top of the panel surface.
 *
 *   ┌───────────────────────────────────┐  bg = --color-card (content card)
 *   │ [📐 select mode] [chip] [chip]…   │  composer-top   p 8/16, min-h 32
 *   │ ─────────────────────────────────── │  chips/input divider
 *   │ describe what you want…            │  composer-input p 10/12/4
 *   │ ─────────────────────────────────── │
 *   │ [✨ Skill]                  [↑]    │  composer-actions p 12/16/16
 *   └───────────────────────────────────┘  radius = --radius-content-md (12px)
 *
 * Visual tokens (mock-aligned, see CSS lines 627-758):
 *   - Outer card uses `bg-card` (content-card tier; the former `elevated`
 *     step was removed 2026-06-13; ADR 14 brand-guard forbids raw
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
 *   - The bottom-right corner has 4 states: disabled send (empty draft),
 *     ready send (foreground/background swap), waiting (a spinner, nothing
 *     to press), streaming (destructive accent → Abort with Square icon)
 * @param root0 - The component props.
 * @param root0.draft - The current draft text in the input.
 * @param root0.turnPhase - How far along the turn is: idle, sending, running.
 * @param root0.chips - The reference chips attached to the next message.
 * @param root0.activeSkillLabel - The label of the currently selected skill, if any.
 * @param root0.selectMode - Whether canvas select mode is active.
 * @param root0.onChange - Called with the next draft text on each edit.
 * @param root0.onSubmit - Called to send the draft message.
 * @param root0.onAbort - Called to abort the in-flight streaming response.
 * @param root0.onToggleSelectMode - Called to toggle canvas select mode.
 * @param root0.onPickSkill - Called to open the skill picker.
 * @param root0.onRemoveChip - Called with a chip id to detach that reference.
 * @returns The composer card with chips, textarea, and action buttons.
 */
function ChatComposerInner({
  draft,
  turnPhase = 'idle',
  chips = [],
  activeSkillLabel,
  selectMode,
  onChange,
  onSubmit,
  onAbort,
  onToggleSelectMode,
  onPickSkill,
  onRemoveChip,
}: ChatComposerProps): React.JSX.Element {
  const t = useTranslation();
  const ready = draft.trim().length > 0 && turnPhase === 'idle';
  const box = React.useRef<HTMLTextAreaElement>(null);

  /**
   * Submit the draft message when the composer is in a ready state.
   *
   * Hands the keyboard to the box on the way out. Whoever pressed this with
   * the keyboard is standing on a button that is about to be a different
   * one -- the same element serves send, the wait and stop, which is what
   * keeps the focus from falling to the body when the phase changes. Left
   * standing there, their next keypress reaches stop: they would be ending
   * the answer they just asked for, having aimed at nothing of the sort.
   * The box is where they act next anyway, and it is the one thing here that
   * does not change meaning underneath them.
   */
  const submit = (): void => {
    if (!ready) return;
    onSubmit();
    box.current?.focus();
  };

  return (
    <div
      data-testid='chat-composer'
      className='m-2.5 flex flex-col overflow-hidden rounded-md border border-border bg-card transition-colors focus-within:border-active-border'
    >
      <div className='flex min-h-[var(--btn-chrome)] flex-nowrap items-center gap-1.5 border-b border-border px-2 py-1'>
        <Button
          type='button'
          variant={null}
          size={null}
          aria-label={t('chat.composer.selectMode.label')}
          title={t('chat.composer.selectMode.title')}
          onClick={onToggleSelectMode}
          data-testid='chat-composer-select-mode'
          aria-pressed={selectMode}
          className={`inline-flex h-[var(--btn-chrome)] w-[var(--btn-chrome)] shrink-0 items-center justify-center rounded-chrome transition-colors ${
            selectMode
              ? 'bg-foreground text-background'
              : 'bg-transparent text-muted-foreground hover:bg-accent hover:text-foreground'
          }`}
        >
          <SquareMousePointer className='h-4 w-4' />
        </Button>
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
              className='inline-flex h-6 items-center gap-1 rounded-chrome border border-border bg-muted pl-2 pr-1 text-xs text-foreground'
              data-testid={`chat-chip-${chip.id}`}
            >
              {chip.type ? (
                <span className='text-2xs text-muted-foreground'>
                  {chip.type}
                </span>
              ) : null}
              <span className='truncate'>{chip.label}</span>
              {onRemoveChip ? (
                <Button
                  type='button'
                  variant={null}
                  size={null}
                  aria-label={`Remove ${chip.label}`}
                  onClick={() => onRemoveChip(chip.id)}
                  className='inline-flex h-4 w-4 items-center justify-center rounded-chrome text-xs leading-none text-muted-foreground hover:bg-accent hover:text-foreground'
                >
                  ×
                </Button>
              ) : null}
            </span>
          ))}
        </div>
      </div>
      <textarea
        ref={box}
        value={draft}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          // Typing Chinese, Japanese or Korean means pressing Enter to accept
          // what the IME is offering, several times per sentence. The browser
          // marks that keystroke as part of the composition, and that mark is
          // the only thing separating it from the Enter that means "send" —
          // both arrive as `key === 'Enter'` with no modifier. Without this
          // check the first message a CJK reader ever sends is the raw
          // keystrokes they were still choosing between.
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            submit();
          }
        }}
        placeholder={t('chat.composer.placeholder')}
        rows={3}
        className='block max-h-[200px] min-h-[72px] w-full resize-none border-0 bg-transparent px-3 pb-1 pt-2.5 text-sm leading-normal text-foreground outline-none placeholder:text-muted-foreground'
        aria-label={t('chat.composer.inputAria')}
        data-testid='chat-composer-textarea'
      />
      <div className='flex items-center justify-between gap-2 px-2 pb-2 pt-1.5'>
        <Button
          type='button'
          variant={null}
          size={null}
          aria-label={t('chat.composer.skill.label')}
          title={t('chat.composer.skill.title')}
          onClick={onPickSkill}
          data-testid='chat-composer-skill'
          className={`inline-flex h-[var(--btn-inline)] items-center gap-1.5 rounded-chrome border border-transparent px-2 text-xs font-medium transition-colors ${
            activeSkillLabel
              ? 'border-foreground bg-foreground text-background'
              : 'bg-transparent text-muted-foreground hover:bg-accent hover:text-foreground'
          }`}
        >
          <Wand2 className='h-4 w-4' />
          <span>{activeSkillLabel ?? 'Skill'}</span>
        </Button>
        {turnPhase === 'sending' ? (
          // The press landed and the server has not spoken yet. Something has
          // to stand here or the press reads as having done nothing -- but it
          // is not a control: there is nothing to press that would help, so
          // there is nothing to reach with the keyboard either. Kept out of
          // the tab order for a reason beyond having no use: a moment later
          // this slot is the stop button, and anything focusable here can be
          // tabbed to and then turn into something else underneath whoever
          // is standing on it. What it has to say is said by the live region
          // below, which is where a reader hears it anyway.
          <span
            data-testid='chat-composer-sending'
            aria-hidden='true'
            className='inline-flex h-[var(--btn-inline)] w-[var(--btn-inline)] shrink-0 items-center justify-center rounded-chrome text-muted-foreground'
          >
            <Loader2 className='h-4 w-4 animate-spin' />
          </span>
        ) : turnPhase === 'running' ? (
          <Button
            type='button'
            variant={null}
            size={null}
            aria-label='Abort'
            onClick={onAbort}
            data-testid='chat-composer-abort'
            className='inline-flex h-[var(--btn-inline)] w-[var(--btn-inline)] shrink-0 items-center justify-center rounded-chrome border border-status-error-border bg-status-error-bg text-status-error-foreground transition-colors hover:border-status-error'
          >
            <Square className='h-4 w-4' />
          </Button>
        ) : (
          <Button
            type='button'
            variant={null}
            size={null}
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
          </Button>
        )}
        {/* Here whether or not there is anything to say, so that a reader is
            told when it fills rather than when it appears: a live region
            inserted already holding its text is one many screen readers never
            announce. The wait used to be announced by the indicator itself,
            which is exactly that -- and the indicator is now a button, whose
            own role is the one worth having on a focused element. */}
        <span className='sr-only' role='status'>
          {turnPhase === 'sending' ? t('chat.composer.sending') : ''}
        </span>
      </div>
    </div>
  );
}

export type { ReferenceChip };

/**
 * Rendered again only when its own props change.
 *
 * A reply arriving token by token re-renders the panel that owns this, and
 * without this that re-render reaches here as well -- sixty times a second,
 * for a component whose props did not move. Every callback it is handed keeps
 * the same identity across those renders, which is what lets the comparison
 * actually stop anything; `draft` is the one prop that does change, and it
 * changes only when the reader types.
 */
export const ChatComposer = React.memo(ChatComposerInner);
