// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import * as React from 'react';
import { useMutation } from '@tanstack/react-query';

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
import type { StudioMember } from '@web/pages/studio/container/container-types';

/**
 * The single "Transfer Studio" entry (2026-07-08 decision A) — a button in the
 * Settings danger zone that opens a recipient picker. The only eligible
 * recipients are the studio's non-guest members other than the admin, i.e. the
 * maintainers (the sole admin is the acting user). Sending is a two-step
 * handshake: it dispatches a request the recipient accepts via their bell; the
 * admin role does not change until then. Replaces the former per-member-row
 * "Transfer admin" action (single entry, avoids two places).
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
  const [open, setOpen] = React.useState(false);
  const [selected, setSelected] = React.useState('');

  const candidates = members.filter((m) => m.studioRole === 'maintainer');

  const transferMutation = useMutation({
    mutationFn: (userId: string) =>
      studiosApi.requestTransfer(slug, { toUserId: userId }),
    onSuccess: () => {
      setOpen(false);
      setSelected('');
      toast.success(t('studio.container.members.transferRequested'));
    },
    onError: (err) =>
      toast.error(
        err instanceof ApiException
          ? err.message
          : t('studio.container.members.actionFailed'),
      ),
  });

  return (
    <>
      <button
        type='button'
        className='h-[30px] rounded-chrome border border-border px-3 text-xs font-medium transition-colors hover:bg-accent'
        onClick={() => setOpen(true)}
        data-testid='settings-transfer-open'
      >
        {t('studio.container.settings.transfer')}
      </button>

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
              <Button variant='ghost' size='sm' onClick={() => setOpen(false)}>
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
