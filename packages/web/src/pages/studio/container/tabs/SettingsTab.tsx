// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import * as React from 'react';
import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';

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
import type { StudioDetail } from '@web/pages/studio/container/container-types';
import type { StudioMember } from '@web/pages/studio/container/container-types';

interface SettingsTabProps {
  studio: StudioDetail;
  /** The studio's members — the transfer picker lists the non-guest ones. */
  members: readonly StudioMember[];
}

/**
 * One read-only labeled field in the settings basic-info section. Mirrors the
 * locked mock `.field`: a 600-weight label over a bordered, tinted read-only
 * value box (`.fv`); the `mono` variant renders the value in a monospace font
 * (used for the URL slug).
 * @param root0 the field's label, value and mono flag.
 * @param root0.label the display label.
 * @param root0.value the current field value.
 * @param root0.mono whether to render the value in a monospace font (slug).
 * @returns the labeled field.
 */
function Field({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}): React.JSX.Element {
  return (
    <div className='flex flex-col gap-1.5'>
      <span className='text-xs font-semibold text-muted-foreground'>
        {label}
      </span>
      <span
        className={`rounded-chrome border border-border bg-muted px-2.5 py-2 text-sm ${
          mono ? 'font-mono text-muted-foreground' : 'text-foreground'
        }`}
      >
        {value || '—'}
      </span>
    </div>
  );
}

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
function TransferStudioSection({
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
              <Button
                variant='ghost'
                size='sm'
                onClick={() => setOpen(false)}
              >
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

/**
 * The Settings tab (spec §3.11) — studio basic info plus a governance "danger
 * zone". Per DD §3.11 the transfer / delete actions are Admin-only and never
 * available for the personal studio (permanent); they show here only for a team
 * studio whose viewer is an Admin. The "Transfer Studio" button opens the
 * recipient picker (2026-07-08 decision A — the single transfer entry). Basic-info
 * editing wires to the real API in Phase 2 (read-only display here). The "bio"
 * field from the mock is omitted until the studio contract carries a
 * `description` (backend gap).
 * @param props the current studio detail + its members.
 * @param props.studio the studio detail to render.
 * @param props.members the studio members (the transfer picker's candidate source).
 * @returns the Settings tab content.
 */
export function SettingsTab({
  studio,
  members,
}: SettingsTabProps): React.JSX.Element {
  const t = useTranslation();
  const canGovern = studio.myStudioRole === 'admin' && studio.type === 'team';
  return (
    <div className='mx-auto flex max-w-xl flex-col gap-8'>
      <section className='flex flex-col gap-4'>
        <h3 className='text-xs font-bold uppercase tracking-[0.04em] text-muted-foreground'>
          {t('studio.container.settings.basicTitle')}
        </h3>
        <Field label={t('studio.container.settings.name')} value={studio.name} />
        <Field
          label={t('studio.container.settings.slug')}
          value={studio.slug}
          mono
        />
      </section>

      {canGovern ? (
        <section className='flex flex-col gap-2 rounded-chrome border border-status-error-foreground p-4'>
          <h3 className='text-sm font-bold text-status-error-foreground'>
            {t('studio.container.settings.dangerTitle')}
          </h3>
          <p className='text-xs text-muted-foreground'>
            {t('studio.container.settings.dangerHint')}
          </p>
          <div className='mt-1 flex gap-2.5'>
            <TransferStudioSection slug={studio.slug} members={members} />
            <button
              type='button'
              className='h-[30px] rounded-chrome border border-status-error-foreground px-3 text-xs font-medium text-status-error-foreground transition-colors hover:bg-accent'
            >
              {t('studio.container.settings.delete')}
            </button>
          </div>
        </section>
      ) : null}
    </div>
  );
}
