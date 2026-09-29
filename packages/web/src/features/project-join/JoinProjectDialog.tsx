// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { getLocale } from '@breatic/shared';

import { Button } from '@web/components/ui/button';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@web/components/ui/dialog';
import { Label } from '@web/components/ui/label';
import { Textarea } from '@web/components/ui/textarea';
import { projectJoinRequestsApi } from '@web/data/api/project-join-requests';
import type { MyJoinRequest } from '@web/data/api/project-join-requests';
import { ApiException } from '@web/data/api/types';
import { useTranslation } from '@web/i18n/use-translation';
import { toast } from '@web/lib/toast';

interface JoinProjectDialogProps {
  projectId: string;
  open: boolean;
  /** Called with `false` when the dialog closes, by the reader or on a failed read. */
  onOpenChange: (open: boolean) => void;
}

/**
 * The query key of the caller's join-request view on one project.
 * @param projectId - The project.
 * @returns The key.
 */
export function joinRequestQueryKey(projectId: string): readonly unknown[] {
  return ['project-join', projectId];
}

/**
 * The server's own sentence when it sent one, else the fallback.
 * @param err - What the call threw.
 * @param fallback - The sentence to show otherwise.
 * @returns The message for the toast.
 */
function messageOf(err: unknown, fallback: string): string {
  return err instanceof ApiException && err.message !== '' ? err.message : fallback;
}

/**
 * Offered in place of a project the reader is not a member of: ask its owner
 * to let them in, see that a request is pending, or withdraw it.
 *
 * Opened by a project card click and by a direct link that answered 403. It
 * reads the caller's pending request first and holds the request button until
 * that read is back, so a reader who already asked is shown their request
 * rather than a button the server would refuse.
 * @param props - The project and the open state.
 * @param props.projectId - The project the reader cannot enter.
 * @param props.open - Whether the dialog is shown.
 * @param props.onOpenChange - Close callback.
 * @returns The dialog.
 */
export function JoinProjectDialog({
  projectId,
  open,
  onOpenChange,
}: JoinProjectDialogProps): React.JSX.Element {
  const t = useTranslation();
  const queryClient = useQueryClient();
  const [message, setMessage] = React.useState('');
  const [sent, setSent] = React.useState(false);

  const view = useQuery({
    queryKey: joinRequestQueryKey(projectId),
    queryFn: () => projectJoinRequestsApi.mine(projectId),
    enabled: open,
    staleTime: 0,
  });

  const { isError } = view;
  React.useEffect(() => {
    if (!isError) return;
    toast.error(t('projectJoin.loadFailed'));
    onOpenChange(false);
  }, [isError, onOpenChange, t]);

  const setView = React.useCallback(
    (next: MyJoinRequest) => queryClient.setQueryData(joinRequestQueryKey(projectId), next),
    [projectId, queryClient],
  );

  const { mutate: sendRequest, isPending: sending } = useMutation({
    mutationFn: () => projectJoinRequestsApi.request(projectId, message.trim() || undefined),
    onSuccess: () => {
      setSent(true);
      void queryClient.invalidateQueries({ queryKey: joinRequestQueryKey(projectId) });
    },
    onError: (err) => toast.error(messageOf(err, t('projectJoin.requestFailed'))),
  });

  const { mutate: withdrawRequest, isPending: withdrawing } = useMutation({
    mutationFn: () => projectJoinRequestsApi.cancelMine(projectId),
    onSuccess: () => {
      if (view.data) setView({ ...view.data, pendingRequest: null });
    },
    onError: (err) => toast.error(messageOf(err, t('projectJoin.withdrawFailed'))),
  });

  const handleOpenChange = React.useCallback(
    (next: boolean) => {
      if (!next) {
        setMessage('');
        setSent(false);
      }
      onOpenChange(next);
    },
    [onOpenChange],
  );
  const close = React.useCallback(() => handleOpenChange(false), [handleOpenChange]);
  const onSend = React.useCallback(() => sendRequest(), [sendRequest]);
  const onWithdraw = React.useCallback(() => withdrawRequest(), [withdrawRequest]);
  const onMessageChange = React.useCallback(
    (event: React.ChangeEvent<HTMLTextAreaElement>) => setMessage(event.target.value),
    [],
  );

  const data = view.data;
  const projectName = data?.project.name ?? '';
  const pending = data?.pendingRequest ?? null;

  let content: React.JSX.Element;
  if (sent) {
    content = (
      <>
        <DialogHeader>
          <DialogTitle>{t('projectJoin.sentTitle')}</DialogTitle>
          <DialogDescription>{t('projectJoin.sentBody')}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type='button' onClick={close}>
            {t('projectJoin.ok')}
          </Button>
        </DialogFooter>
      </>
    );
  } else if (pending !== null) {
    const date = new Date(pending.createdAt).toLocaleDateString(getLocale());
    content = (
      <>
        <DialogHeader>
          <DialogTitle>{t('projectJoin.pendingTitle')}</DialogTitle>
          <DialogDescription>
            {t('projectJoin.pendingBody', { project: projectName, date })}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            type='button'
            variant='outline'
            onClick={onWithdraw}
            disabled={withdrawing}
          >
            {withdrawing ? (
              <Loader2 aria-hidden='true' className='mr-2 h-3.5 w-3.5 animate-spin' />
            ) : null}
            {t('projectJoin.withdraw')}
          </Button>
          <Button type='button' onClick={close} disabled={withdrawing}>
            {t('projectJoin.ok')}
          </Button>
        </DialogFooter>
      </>
    );
  } else {
    const loading = data === undefined;
    content = (
      <>
        <DialogHeader>
          <DialogTitle>{t('projectJoin.title')}</DialogTitle>
          {loading ? null : (
            <DialogDescription>{t('projectJoin.body', { project: projectName })}</DialogDescription>
          )}
        </DialogHeader>
        <DialogBody className='flex flex-col gap-1.5'>
          {loading ? (
            <div className='flex justify-center py-6 text-muted-foreground'>
              <Loader2 aria-hidden='true' className='h-5 w-5 animate-spin' />
            </div>
          ) : (
            <>
              <Label htmlFor='join-project-message'>{t('projectJoin.messageLabel')}</Label>
              <Textarea
                id='join-project-message'
                value={message}
                maxLength={500}
                placeholder={t('projectJoin.messagePlaceholder')}
                onChange={onMessageChange}
                disabled={sending}
              />
            </>
          )}
        </DialogBody>
        <DialogFooter>
          <Button type='button' variant='outline' onClick={close}>
            {t('projectJoin.cancel')}
          </Button>
          <Button type='button' onClick={onSend} disabled={loading || sending}>
            {sending ? (
              <Loader2 aria-hidden='true' className='mr-2 h-3.5 w-3.5 animate-spin' />
            ) : null}
            {t('projectJoin.request')}
          </Button>
        </DialogFooter>
      </>
    );
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent data-testid='join-project-dialog'>{content}</DialogContent>
    </Dialog>
  );
}
