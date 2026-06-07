// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import type * as React from 'react';

import { Label } from '@web/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@web/components/ui/select';

/** One selectable studio (only the fields the selector renders). */
export interface StudioOption {
  id: string;
  name: string;
}

interface StudioSelectFieldProps {
  /** The studios the viewer may create in (already filtered to admin/creator). */
  studios: readonly StudioOption[];
  /** The currently selected studio id. */
  value: string;
  /** Called with the newly selected studio id. */
  onChange: (id: string) => void;
  /** The localized field label. */
  label: string;
  /** Trigger element id (ties the label to the combobox); defaults to `studio-select`. */
  id?: string;
}

/**
 * The create-project studio selector (spec §7.1, GitHub-owner style) — picks
 * which studio a new project is created in. It lists only the studios the
 * viewer may create projects in (admin/creator, computed by the caller via
 * `creatableStudios`). Today that is usually one option (the personal studio),
 * but the control is rendered regardless so it is forward-correct once team
 * studios land — no rework needed.
 * @param props the studios, the selected value, the change handler and label.
 * @param props.studios the selectable studios.
 * @param props.value the selected studio id.
 * @param props.onChange called with the newly selected studio id.
 * @param props.label the field label.
 * @param props.id the trigger element id.
 * @returns the studio selector field.
 */
export function StudioSelectField({
  studios,
  value,
  onChange,
  label,
  id = 'studio-select',
}: StudioSelectFieldProps): React.JSX.Element {
  return (
    <div className='flex flex-col gap-1.5'>
      <Label htmlFor={id}>{label}</Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger id={id}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {studios.map((studio) => (
            <SelectItem key={studio.id} value={studio.id}>
              {studio.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
