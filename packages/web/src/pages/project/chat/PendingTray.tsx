// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The messages waiting for the Agent to read them, above the composer
 * (inner#1717).
 *
 * What it lists is the server's queue for the conversation, so every page
 * showing the conversation lists the same. Each message can be taken back
 * into the box or deleted; the button pressed waits while the server answers.
 */
import { Clock, Trash2, Undo2 } from 'lucide-react';
import * as React from 'react';
import type { ChatPendingItem } from '@breatic/shared';

import { Button } from '@web/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@web/components/ui/tooltip';
import { useTranslation } from '@web/i18n/use-translation';
import { AttachmentChip } from '@web/pages/project/chat/AttachmentChip';

interface PendingTrayProps {
  items: readonly ChatPendingItem[];
  /** A card waits for the user's answer, and these go after it. */
  awaiting: boolean;
  /** The balance cannot pay for the run these would open. */
  blocked: boolean;
  /** Which messages are being taken back, and how. */
  busy: Readonly<Record<string, 'retract' | 'delete'>>;
  /** Take a message back into the box, or delete it. */
  onTakeBack: (item: ChatPendingItem, how: 'retract' | 'delete') => void;
}

interface TrayButtonProps {
  label: string;
  icon: React.ReactElement<{ className?: string }>;
  busy: boolean;
  onPress: () => void;
  testId: string;
}

/**
 * One of a waiting message's two buttons.
 * @param root0 - Props.
 * @param root0.label - What it does, shown on hover.
 * @param root0.icon - Its icon.
 * @param root0.busy - It was pressed and the server has not answered.
 * @param root0.onPress - What a press does.
 * @param root0.testId - Its test id.
 * @returns The button.
 */
function TrayButton({ label, icon, busy, onPress, testId }: TrayButtonProps): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type='button'
          variant='chrome-ghost'
          size={null}
          aria-label={label}
          loading={busy}
          icon={icon}
          onClick={onPress}
          data-testid={testId}
          className='size-[var(--btn-compact)] shrink-0'
        />
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/**
 * The waiting area.
 * @param root0 - Props.
 * @param root0.items - The messages waiting.
 * @param root0.awaiting - A card waits for an answer first.
 * @param root0.blocked - The balance cannot pay.
 * @param root0.busy - Which are being taken back.
 * @param root0.onTakeBack - Take one back or delete it.
 * @returns The area, or nothing while nothing waits.
 */
function PendingTrayInner({ items, awaiting, blocked, busy, onTakeBack }: PendingTrayProps): React.JSX.Element | null {
  const t = useTranslation();
  if (items.length === 0) return null;
  const note = blocked ? t('chat.waiting.blocked') : awaiting ? t('chat.waiting.awaitingCard') : null;
  return (
    <div data-testid='chat-waiting-tray' className='mx-[var(--space-5)] -mb-[var(--space-3)] rounded-chrome border border-border bg-card'>
      <div className='px-2.5 pb-1 pt-2 text-xs'>
        <div data-testid='chat-waiting-title' className='flex items-center gap-1.5 text-muted-foreground'>
          <Clock className='h-3.5 w-3.5 shrink-0' aria-hidden='true' />
          <span className='min-w-0 truncate'>{t('chat.waiting.title', { count: items.length })}</span>
        </div>
        {/* Indented by the clock and the gap, so it starts under the title's words. */}
        {note === null ? null : <p data-testid='chat-waiting-note' className='mt-0.5 pl-5 text-foreground'>{note}</p>}
      </div>
      <ul aria-label={t('chat.waiting.listAria')}>
        {items.map((item) => {
          const pressed = busy[item.id];
          return (
            <li key={item.id} data-testid='chat-waiting-item' className='flex items-start gap-1 border-t border-border px-2.5 py-1.5'>
              <div className='flex min-w-0 flex-1 flex-col gap-1 pr-1'>
                {item.chips.length > 0 ? (
                  <div className='flex flex-wrap gap-1'>
                    {item.chips.map((chip) => (
                      <AttachmentChip key={chip.id} id={chip.id} type={chip.type} name={chip.name} chip={chip} status='ready' testId={`chat-waiting-chip-${chip.id}`} />
                    ))}
                  </div>
                ) : null}
                <div className='line-clamp-2 break-words text-sm'>{item.words}</div>
              </div>
              <TrayButton
                label={t('chat.waiting.retract')}
                icon={<Undo2 className='h-3.5 w-3.5' />}
                busy={pressed === 'retract'}
                onPress={() => {
                  if (pressed === undefined) onTakeBack(item, 'retract');
                }}
                testId='chat-waiting-retract'
              />
              <TrayButton
                label={t('chat.waiting.delete')}
                icon={<Trash2 className='h-3.5 w-3.5' />}
                busy={pressed === 'delete'}
                onPress={() => {
                  if (pressed === undefined) onTakeBack(item, 'delete');
                }}
                testId='chat-waiting-delete'
              />
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Rendered again only when its own props change. */
export const PendingTray = React.memo(PendingTrayInner);
