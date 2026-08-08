// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { Button } from '@web/components/ui/button';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@web/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@web/components/ui/select';
import { studiosApi } from '@web/data/api/studios';
import { ApiException } from '@web/data/api/types';
import { useTranslation } from '@web/i18n/use-translation';
import { toast } from '@web/lib/toast';
import { expiresInLabel } from '@web/lib/expires-in';
import type { StudioMember } from '@web/pages/studio/container/container-types';

/**
 * The single "Transfer Studio" entry (2026-07-08 decision A) — a button in the
 * Settings danger zone that opens a recipient picker. The only eligible
 * recipients are the studio's non-guest members other than the admin, i.e. the
 * maintainers (the sole admin is the acting user). Sending is a two-step
 * handshake: it dispatches a request the recipient accepts via their bell; the
 * admin role does not change until then. Replaces the former per-member-row
 * "Transfer admin" action (single entry, avoids two places).
 *
 * A studio has one admin, so it can hold only one outstanding offer. While it
 * does, this entry becomes that offer's status and a withdraw button rather
 * than a second picker — sending again would just answer 409, and the withdraw
 * is the only way to redirect an offer to somebody else before it times out.
 * @param root0 - Transfer section props.
 * @param root0.slug - The studio's URL handle (the transfer request path param).
 * @param root0.members - The studio members (source of the maintainer candidates).
 * @returns the transfer button + its recipient-picker dialog.
 */
export function TransferStudioSection({
  slug,
  members,
}: {
  slug: string;
  members: readonly StudioMember[];
}): React.JSX.Element {
  const t = useTranslation();
  const queryClient = useQueryClient();
  const [open, setOpen] = React.useState(false);
  const [selected, setSelected] = React.useState('');
  const liveKey = React.useMemo(
    () => ['studio-transfer', 'live', slug],
    [slug],
  );

  const candidates = members.filter((m) => m.studioRole === 'maintainer');

  const liveQuery = useQuery({
    queryKey: liveKey,
    queryFn: () => studiosApi.liveTransfer(slug),
    // Polls like the bell does. The offer can end without this tab doing
    // anything — the recipient accepts or declines from their own — and a
    // surface that never refetches keeps a Withdraw button over an offer that
    // is already over, which answers 404 and reads as a failure.
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  });
  const live = liveQuery.data ?? null;
  // Empty when the recipient is not in the loaded roster — they left the
  // container, or were never in this particular list. The offer is still real
  // and still confirmable by them, so the banner says so without naming a
  // person it cannot name.
  const recipientName = members.find((m) => m.id === live?.toUserId)?.name ?? '';

  const transferMutation = useMutation({
    mutationFn: (userId: string) =>
      studiosApi.requestTransfer(slug, { toUserId: userId }),
    onSuccess: async () => {
      setOpen(false);
      setSelected('');
      toast.success(t('studio.container.members.transferRequested'));
      // The entry flips to its pending state off this read.
      await queryClient.invalidateQueries({ queryKey: liveKey });
    },
    onError: (err) =>
      toast.error(
        err instanceof ApiException
          ? err.message
          : t('studio.container.members.actionFailed'),
      ),
  });

  const withdrawMutation = useMutation({
    mutationFn: (transferId: string) =>
      studiosApi.withdrawTransfer(slug, transferId),
    onSuccess: async () => {
      toast.success(t('studio.container.settings.transferWithdrawn'));
      await queryClient.invalidateQueries({ queryKey: liveKey });
    },
    onError: (err) =>
      toast.error(
        err instanceof ApiException
          ? err.message
          : t('studio.container.settings.transferWithdrawFailed'),
      ),
  });

  const onWithdraw = React.useCallback(() => {
    if (live) withdrawMutation.mutate(live.id);
  }, [live, withdrawMutation]);

  if (live) {
    return (
      <div
        className='flex items-center gap-3'
        data-testid='settings-transfer-pending'
      >
        <span className='text-xs text-muted-foreground'>
          {recipientName
            ? t('studio.container.settings.transferPending', { name: recipientName })
            : t('studio.container.settings.transferPendingUnnamed')}
        </span>
        <span
          className='text-2xs text-muted-foreground'
          data-testid='settings-transfer-expiry'
        >
          {expiresInLabel(live.expiresAt, t)}
        </span>
        <Button
          type='button'
          variant={null}
          size={null}
          className='h-[30px] rounded-chrome border border-border px-3 text-xs font-medium transition-colors hover:bg-accent'
          disabled={withdrawMutation.isPending}
          onClick={onWithdraw}
          data-testid='settings-transfer-withdraw'
        >
          {t('studio.container.settings.transferWithdraw')}
        </Button>
      </div>
    );
  }

  return (
    <>
      <Button
        type='button'
        variant={null}
        size={null}
        className='h-[30px] rounded-chrome border border-border px-3 text-xs font-medium transition-colors hover:bg-accent'
        onClick={() => setOpen(true)}
        data-testid='settings-transfer-open'
      >
        {t('studio.container.settings.transfer')}
      </Button>

      <Dialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setSelected('');
        }}
      >
        <DialogContent data-testid='settings-transfer-dialog'>
          <DialogHeader>
            <DialogTitle>
              {t('studio.container.settings.transferTitle')}
            </DialogTitle>
            <DialogDescription>
              {t('studio.container.settings.transferBody')}
            </DialogDescription>
          </DialogHeader>
          <DialogBody className='flex flex-col gap-3'>
            {candidates.length === 0 ? (
              <span className='text-xs text-muted-foreground'>
                {t('studio.container.settings.transferNoCandidates')}
              </span>
            ) : (
              <Select value={selected} onValueChange={setSelected}>
                <SelectTrigger
                  data-testid='settings-transfer-select'
                  aria-label={t(
                    'studio.container.settings.transferSelectPlaceholder',
                  )}
                >
                  <SelectValue
                    placeholder={t(
                      'studio.container.settings.transferSelectPlaceholder',
                    )}
                  />
                </SelectTrigger>
                <SelectContent>
                  {candidates.map((m) => (
                    <SelectItem key={m.id} value={m.id}>
                      {m.email ? `${m.name} · ${m.email}` : m.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            <div className='flex items-center justify-end gap-2'>
              <Button variant='outline' size='sm' onClick={() => setOpen(false)}>
                {t('studio.container.dialog.cancel')}
              </Button>
              <Button
                size='sm'
                disabled={!selected || transferMutation.isPending}
                onClick={() => transferMutation.mutate(selected)}
                data-testid='settings-transfer-send'
              >
                {t('studio.container.members.transferConfirmAction')}
              </Button>
            </div>
          </DialogBody>
        </DialogContent>
      </Dialog>
    </>
  );
}
