// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import * as React from 'react';
import { ChevronDown } from 'lucide-react';
import type { AgentModelChoice } from '@breatic/shared';

import { Button } from '@web/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@web/components/ui/popover';
import { cn } from '@web/lib/utils';
import { chatApi } from '@web/data/api/chat';
import { useChatModels } from '@web/data/use-chat-models';
import { useTranslation } from '@web/i18n/use-translation';
import { toast } from '@web/lib/toast';
import { usePendingKeys } from '@web/lib/use-pending-keys';
import { conversationRuntime, useConversationRuntime } from '@web/stores/conversation-runtime';

/** Which conversation the picker is for. */
export interface ModelPickerProps {
  conversationId: string;
  projectId: string;
}

/**
 * The model picker in the composer (#1363): the model the conversation on
 * screen is answered by, and a menu of the models the user can pick.
 *
 * A pick is saved first: the button waits, still showing the saved model,
 * and then shows the model the server saved. A save that fails leaves the
 * saved model and asks for the list again: the model may have been taken
 * off. While the list is loading or failed to load,
 * it shows the conversation's model and cannot be opened. A conversation whose
 * model the page's list lacks keeps showing it while the list is asked for
 * again; only when that list still lacks it does it show the model a new
 * conversation would start on, and the next message goes with that one, which
 * the server then writes.
 * @param props - Which conversation.
 * @param props.conversationId - The conversation on screen.
 * @param props.projectId - The Project it is in.
 * @returns The picker, or nothing before the conversation is loaded.
 */
function ModelPickerInner({ conversationId, projectId }: ModelPickerProps): React.JSX.Element | null {
  const t = useTranslation();
  const stored = useConversationRuntime((s) => s.conversations[conversationId]?.agentModel);
  const asks = useConversationRuntime((s) => s.modelListAsks);
  const list = useChatModels(asks);
  const models = list.data?.models;
  const lastUsed = list.data?.lastUsed;

  // The server hands over only listed models, so one missing from the list
  // here may be newer than the list: the list is asked for again first.
  const [askedFor, setAskedFor] = React.useState<string | null>(null);
  const missing = stored !== undefined && models !== undefined && !models.some((m) => m.id === stored.id);
  const settled = askedFor === stored?.id && !list.isPlaceholderData && !list.isFetching;
  React.useEffect(() => {
    if (missing && askedFor !== stored.id) {
      setAskedFor(stored.id);
      conversationRuntime.askModelListAgain();
    }
  }, [missing, askedFor, stored]);

  const shown = React.useMemo((): AgentModelChoice | undefined => {
    if (stored === undefined || models === undefined) return stored;
    const listed = models.find((m) => m.id === stored.id);
    if (listed !== undefined) return listed;
    if (!settled) return stored;
    return models.find((m) => m.id === lastUsed) ?? models[0] ?? stored;
  }, [stored, models, lastUsed, settled]);

  // The message goes with what the picker shows.
  React.useEffect(() => {
    if (shown !== undefined && stored !== undefined && shown.id !== stored.id) {
      conversationRuntime.setAgentModel(conversationId, shown);
    }
  }, [conversationId, shown, stored]);

  // Said once for each time the list fails to arrive.
  const listFailed = t('chat.modelPicker.listFailed');
  React.useEffect(() => {
    if (list.isError) toast.error(listFailed);
  }, [list.isError, listFailed]);

  const saveFailed = t('chat.modelPicker.saveFailed');
  const [open, setOpen] = React.useState(false);
  // Kept per conversation: the user may switch away while a save is out.
  const saving = usePendingKeys();
  const { track } = saving;
  const choose = React.useCallback(
    (id: string): void => {
      setOpen(false);
      if (stored === undefined || id === stored.id) return;
      track(conversationId, chatApi.setModel(conversationId, projectId, id)).then(
        (saved) => conversationRuntime.setAgentModel(conversationId, saved),
        () => {
          conversationRuntime.askModelListAgain();
          toast.error(saveFailed);
        },
      );
    },
    [stored, track, conversationId, projectId, saveFailed],
  );
  // Focus goes to the menu itself, so a row shows a focus ring only once the
  // user moved there by keyboard; Radix would focus the first row on open.
  const focusMenu = React.useCallback((event: Event): void => {
    event.preventDefault();
    (event.currentTarget as HTMLElement).focus();
  }, []);

  if (shown === undefined) return null;
  // The same menu the language and theme switchers draw: a column of rows,
  // the current one filled.
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild disabled={!list.isSuccess}>
        <Button
          type='button'
          variant='chrome-ghost'
          size={null}
          data-testid='chat-model-picker'
          loading={saving.isPending(conversationId)}
          // Button draws its spinner with the icon's classes, so a save shows
          // it in the chevron's place and the button keeps its width.
          icon={<ChevronDown className='order-last h-3 w-3 shrink-0' />}
          className='h-[var(--btn-inline)] min-w-0 max-w-[11rem] shrink gap-1 bg-transparent px-1.5 text-xs'
        >
          <span className='truncate'>{shown.name}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent side='top' align='end' className='w-auto min-w-48 p-1'
        data-testid='chat-model-menu'
        onOpenAutoFocus={focusMenu}
      >
        <div className='px-2 py-1.5 text-xs font-medium text-muted-foreground'>{t('chat.modelPicker.label')}</div>
        <div className='flex flex-col gap-0.5'>
          {(models ?? []).map((m) => (
            <Button
              key={m.id}
              type='button'
              variant='ghost'
              size='menu-item'
              aria-pressed={m.id === shown.id}
              className={cn(
                'justify-start',
                m.id === shown.id && 'bg-accent-strong hover-enabled:bg-accent-strong',
              )}
              onClick={() => choose(m.id)}
              data-testid={`chat-model-option-${m.id}`}
            >
              {m.name}
            </Button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** Rendered again only when the conversation it is for changes. */
export const ModelPicker = React.memo(ModelPickerInner);
