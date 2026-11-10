// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import * as React from 'react';

import { AGENT_INSTRUCTIONS_MAX_CHARS, getLocale, t as translate, type AgentInstructionsView } from '@breatic/shared';
import { Button } from '@web/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@web/components/ui/dialog';
import { ScrollArea } from '@web/components/ui/scroll-area';
import { Skeleton } from '@web/components/ui/skeleton';
import { Textarea } from '@web/components/ui/textarea';
import {
  agentInstructionsKey,
  fetchAgentInstructions,
  saveAgentInstructions,
} from '@web/data/api/agent-instructions';
import { useTranslation } from '@web/i18n/use-translation';
import { toast } from '@web/lib/toast';
import { useAutosizeTextarea } from '@web/lib/use-autosize-textarea';
import { cn } from '@web/lib/utils';

/**
 * Save the instructions and put the answer in the cache the header reads.
 *
 * Lives outside the component: a save that settles after the user left the
 * page still writes the cache and says how it went. A read already in flight
 * is cancelled first, so it cannot land after the save and put the old text
 * back.
 * @param client - The query client.
 * @param projectId - The Project.
 * @param text - The text as typed.
 * @returns Whether the save went through.
 */
async function saveInstructions(client: QueryClient, projectId: string, text: string): Promise<boolean> {
  const key = agentInstructionsKey(projectId);
  await client.cancelQueries({ queryKey: key });
  try {
    const saved = await saveAgentInstructions(projectId, text);
    client.setQueryData(key, saved);
    toast.success(translate(saved.text === '' ? 'chat.instructions.cleared' : 'chat.instructions.saved'));
    return true;
  } catch {
    toast.error(translate('chat.instructions.saveFailed'));
    return false;
  }
}

interface AgentInstructionsEditorProps {
  projectId: string;
  /** Close the editor; mounted again for the next opening. */
  onClose: () => void;
}

/**
 * The full-screen editor for a Project's instructions (#1400), mounted once
 * per opening.
 *
 * Opening reads the instructions again and shows a skeleton until that read
 * is back; the draft is taken from it once and the cache never changes it
 * afterwards. A read that settles after this opening was closed only updates
 * the cache. While a save waits, the input and Cancel are off and Esc does
 * nothing.
 * @param root0 - Component props.
 * @param root0.projectId - The Project whose instructions are edited.
 * @param root0.onClose - Closes the editor.
 * @returns The editor.
 */
export function AgentInstructionsEditor({ projectId, onClose }: AgentInstructionsEditorProps): React.JSX.Element {
  const t = useTranslation();
  const client = useQueryClient();
  const [loaded, setLoaded] = React.useState<AgentInstructionsView | null>(null);
  const [draft, setDraft] = React.useState('');
  const [saving, setSaving] = React.useState(false);
  const box = React.useRef<HTMLTextAreaElement>(null);
  useAutosizeTextarea(box, draft);

  React.useEffect(() => {
    let current = true;
    client
      .fetchQuery({
        queryKey: agentInstructionsKey(projectId),
        queryFn: () => fetchAgentInstructions(projectId),
        staleTime: 0,
      })
      .then(
        (view) => {
          if (!current) return;
          setLoaded(view);
          setDraft(view.text);
        },
        () => {
          if (!current) return;
          toast.error(translate('chat.instructions.readFailed'));
          onClose();
        },
      );
    return (): void => {
      current = false;
    };
    // One read per opening: the editor is mounted again for the next one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onOpenChange = React.useCallback(
    (open: boolean): void => {
      if (!open && !saving) onClose();
    },
    [saving, onClose],
  );
  const onChange = React.useCallback((e: React.ChangeEvent<HTMLTextAreaElement>): void => {
    setDraft(e.target.value);
  }, []);
  const onSave = React.useCallback((): void => {
    setSaving(true);
    void saveInstructions(client, projectId, draft).then((ok) => {
      if (ok) onClose();
      else setSaving(false);
    });
  }, [client, projectId, draft, onClose]);

  const locale = getLocale();
  const atLimit = draft.length >= AGENT_INSTRUCTIONS_MAX_CHARS;
  const lastEdited =
    loaded?.updatedBy && loaded.updatedAt
      ? t('chat.instructions.lastEdited', {
        name: loaded.updatedBy,
        time: new Date(loaded.updatedAt).toLocaleString(locale),
      })
      : null;

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent
        data-testid='agent-instructions-editor'
        className='h-[calc(100dvh-2rem)] max-w-none'
      >
        <div className='flex h-12 shrink-0 items-center gap-3 border-b border-border px-4'>
          <div className='min-w-0 flex-1'>
            <DialogTitle className='text-sm font-medium'>{t('chat.instructions.title')}</DialogTitle>
            <DialogDescription className='truncate text-xs text-muted-foreground'>
              {t('chat.instructions.description')}
            </DialogDescription>
          </div>
          <span
            data-testid='agent-instructions-count'
            className={cn('shrink-0 text-xs', atLimit ? 'text-status-warning' : 'text-muted-foreground')}
          >
            {atLimit ? `${t('chat.instructions.atLimit')} · ` : ''}
            {draft.length.toLocaleString(locale)} / {AGENT_INSTRUCTIONS_MAX_CHARS.toLocaleString(locale)}
          </span>
          <Button
            variant='outline'
            size='sm'
            disabled={saving}
            onClick={onClose}
            data-testid='agent-instructions-cancel'
          >
            {t('common.cancel')}
          </Button>
          <Button
            size='sm'
            loading={saving}
            disabled={loaded === null}
            onClick={onSave}
            data-testid='agent-instructions-save'
          >
            {t('chat.instructions.save')}
          </Button>
        </div>
        <ScrollArea scrollbars='vertical' className='min-h-0 flex-1'>
          <div className='mx-auto w-full max-w-[880px] px-6 py-6'>
            {loaded === null ? (
              <Skeleton data-testid='agent-instructions-skeleton' className='h-40 w-full' />
            ) : (
              <Textarea
                ref={box}
                data-testid='agent-instructions-input'
                value={draft}
                maxLength={AGENT_INSTRUCTIONS_MAX_CHARS}
                // eslint-disable-next-line jsx-a11y/no-autofocus -- the editor's only field; users open it to write
                autoFocus
                disabled={saving}
                onChange={onChange}
                placeholder={t('chat.instructions.placeholder')}
                className='min-h-40 resize-none overflow-hidden rounded-none border-0 bg-transparent p-0 text-sm leading-7 shadow-none focus-visible:ring-0'
              />
            )}
          </div>
        </ScrollArea>
        {lastEdited === null ? null : (
          <div className='shrink-0 border-t border-border px-4 py-2 text-xs text-muted-foreground'>{lastEdited}</div>
        )}
      </DialogContent>
    </Dialog>
  );
}
