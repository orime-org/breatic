// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import type * as React from 'react';

import { useTranslation } from '@web/i18n/use-translation';
import type { StudioDetail } from '@web/pages/studio/container/container-types';

interface SettingsTabProps {
  studio: StudioDetail;
}

/**
 * One read-only labeled field in the settings basic-info section.
 * @param root0 the field's label and value.
 * @param root0.label the display label.
 * @param root0.value the current field value.
 * @returns the labeled field.
 */
function Field({
  label,
  value,
}: {
  label: string;
  value: string;
}): React.JSX.Element {
  return (
    <div className='flex flex-col gap-1'>
      <span className='text-xs font-medium text-muted-foreground'>{label}</span>
      <span className='text-sm text-foreground'>{value || '—'}</span>
    </div>
  );
}

/**
 * The Settings tab (spec §3.11) — studio basic info plus a governance "danger
 * zone". Per DD §3.11 the transfer / delete actions are Owner-only and never
 * available for the personal studio (permanent); they show here only for a
 * team studio whose viewer is an Admin. Basic-info editing wires to the real
 * API in Phase 2 (read-only display in slice 3).
 * @param props the current studio detail.
 * @param props.studio the studio detail to render.
 * @returns the Settings tab content.
 */
export function SettingsTab({ studio }: SettingsTabProps): React.JSX.Element {
  const t = useTranslation();
  const canGovern = studio.myStudioRole === 'admin' && studio.type === 'team';
  return (
    <div className='flex max-w-xl flex-col gap-8'>
      <section className='flex flex-col gap-4'>
        <h3 className='text-sm font-semibold'>
          {t('studio.container.settings.basicTitle')}
        </h3>
        <Field label={t('studio.container.settings.name')} value={studio.name} />
        <Field label={t('studio.container.settings.slug')} value={studio.slug} />
      </section>

      {canGovern ? (
        <section className='flex flex-col gap-3 rounded-content-md border border-destructive p-4'>
          <h3 className='text-sm font-semibold text-destructive'>
            {t('studio.container.settings.dangerTitle')}
          </h3>
          <div className='flex gap-3'>
            <button
              type='button'
              className='rounded-chrome border border-border px-3 py-1.5 text-sm transition-colors hover:bg-muted'
            >
              {t('studio.container.settings.transfer')}
            </button>
            <button
              type='button'
              className='rounded-chrome border border-destructive px-3 py-1.5 text-sm text-destructive transition-colors hover:bg-status-error-bg'
            >
              {t('studio.container.settings.delete')}
            </button>
          </div>
        </section>
      ) : null}
    </div>
  );
}
