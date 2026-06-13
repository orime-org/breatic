// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import type * as React from 'react';

import { useTranslation } from '@web/i18n/use-translation';
import type { StudioDetail } from '@web/pages/studio/container/container-types';

interface SettingsTabProps {
  studio: StudioDetail;
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
 * The Settings tab (spec §3.11) — studio basic info plus a governance "danger
 * zone". Per DD §3.11 the transfer / delete actions are Owner-only and never
 * available for the personal studio (permanent); they show here only for a team
 * studio whose viewer is an Admin. Basic-info editing wires to the real API in
 * Phase 2 (read-only display here). The "bio" field from the mock is omitted
 * until the studio contract carries a `description` (backend gap).
 * @param props the current studio detail.
 * @param props.studio the studio detail to render.
 * @returns the Settings tab content.
 */
export function SettingsTab({ studio }: SettingsTabProps): React.JSX.Element {
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
        <section className='flex flex-col gap-2 rounded-chrome border border-status-error p-4'>
          <h3 className='text-sm font-bold text-status-error-foreground'>
            {t('studio.container.settings.dangerTitle')}
          </h3>
          <p className='text-xs text-muted-foreground'>
            {t('studio.container.settings.dangerHint')}
          </p>
          <div className='mt-1 flex gap-2.5'>
            <button
              type='button'
              className='h-[30px] rounded-chrome border border-border px-3 text-xs font-medium transition-colors hover:bg-muted'
            >
              {t('studio.container.settings.transfer')}
            </button>
            <button
              type='button'
              className='h-[30px] rounded-chrome border border-status-error px-3 text-xs font-medium text-status-error-foreground transition-colors hover:bg-muted'
            >
              {t('studio.container.settings.delete')}
            </button>
          </div>
        </section>
      ) : null}
    </div>
  );
}
