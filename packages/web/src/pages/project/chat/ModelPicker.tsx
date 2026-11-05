// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import * as React from 'react';
import { ChevronDown } from 'lucide-react';
import type { AgentModelChoice } from '@breatic/shared';

import { Button } from '@web/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@web/components/ui/dropdown-menu';
import { chatApi } from '@web/data/api/chat';
import { useChatModels } from '@web/data/use-chat-models';
import { useTranslation } from '@web/i18n/use-translation';
import { toast } from '@web/lib/toast';
import { conversationRuntime, useConversationRuntime } from '@web/stores/conversation-runtime';

/** Which conversation the picker is for. */
export interface ModelPickerProps {
  conversationId: string;
  projectId: string;
}

/**
 * The model picker in the composer (#1363): the model the conversation on
 * screen is answered by, and a menu of the models the reader can pick.
 *
 * A pick is shown at once and saved; a save that fails puts the old pick back.
 * While the list is loading or failed to load, it shows the conversation's
 * model and cannot be opened. A conversation whose model the deployment no
 * longer lists shows the model a new conversation would start on, and the
 * next message goes with that one; the server writes it then.
 * @param props - Which conversation.
 * @param props.conversationId - The conversation on screen.
 * @param props.projectId - The Project it is in.
 * @returns The picker, or nothing before the conversation is loaded.
 */
function ModelPickerInner({ conversationId, projectId }: ModelPickerProps): React.JSX.Element | null {
  const t = useTranslation();
  const stored = useConversationRuntime((s) => s.conversations[conversationId]?.agentModel);
  const refused = useConversationRuntime((s) => s.refusedSends);
  const list = useChatModels(refused);
  const models = list.data?.models;
  const lastUsed = list.data?.lastUsed;

  const shown = React.useMemo((): AgentModelChoice | undefined => {
    if (stored === undefined || models === undefined) return stored;
    return models.find((m) => m.id === stored.id) ?? models.find((m) => m.id === lastUsed) ?? models[0] ?? stored;
  }, [stored, models, lastUsed]);

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
  const pick = React.useCallback(
    (id: string): void => {
      const next = models?.find((m) => m.id === id);
      if (next === undefined || stored === undefined || next.id === stored.id) return;
      const before = stored;
      conversationRuntime.setAgentModel(conversationId, next);
      chatApi.setModel(conversationId, projectId, next.id).catch(() => {
        conversationRuntime.setAgentModel(conversationId, before);
        toast.error(saveFailed);
      });
    },
    [models, stored, conversationId, projectId, saveFailed],
  );

  if (shown === undefined) return null;
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild disabled={!list.isSuccess}>
        <Button
          type='button'
          variant='chrome-ghost'
          size={null}
          data-testid='chat-model-picker'
          className='inline-flex h-[var(--btn-inline)] min-w-0 max-w-[11rem] shrink items-center gap-1 bg-transparent px-1.5 text-xs disabled:cursor-not-allowed'
        >
          <span className='truncate'>{shown.name}</span>
          <ChevronDown className='h-3 w-3 shrink-0' />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side='top' align='end' sideOffset={8} className='min-w-48'>
        <DropdownMenuLabel>{t('chat.modelPicker.label')}</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={shown.id} onValueChange={pick}>
          {(models ?? []).map((m) => (
            <DropdownMenuRadioItem key={m.id} value={m.id} className='whitespace-nowrap'>
              {m.name}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Rendered again only when the conversation it is for changes. */
export const ModelPicker = React.memo(ModelPickerInner);
